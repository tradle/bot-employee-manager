const co = require('co').wrap
const { TYPE } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const { parseId, parseStub } = require('@tradle/validate-resource').utils
const {
  debug,
  getCustomMessageProperties,
  pick,
  shallowClone,
  bindAll
} = require('./utils')

const debugObj = obj => debug(JSON.stringify(obj, null, 2))
const PACKAGE_NAME = require('./package').name
const EMPLOYEE_ONBOARDING = 'tradle.EmployeeOnboarding'
const EMPLOYEE_PASS = 'tradle.MyEmployeeOnboarding'
const ASSIGN_RM = 'tradle.AssignRelationshipManager'
const APPROVED = 'tradle.ApplicationApproval'
const DENIAL = 'tradle.ApplicationDenial'
const INTRODUCTION = 'tradle.Introduction'
const SHARE_REQUEST = 'tradle.ShareRequest'
const RESOLVED = Promise.resolve()
// const createAssignRMModel = require('./assign-rm-model')
const alwaysTrue = () => true

exports = module.exports = function createEmployeeManager (opts) {
  return new EmployeeManager(opts)
}

function EmployeeManager ({
  productsAPI,
  approveAll,
  wrapForEmployee,
  shouldForwardFromEmployee=alwaysTrue,
  shouldForwardToEmployee=alwaysTrue
}) {
  bindAll(this)

  // assign relationship manager to customers
  // forward messages between customer and relationship manager
  this.productsAPI = productsAPI
  this._approveAll = approveAll
  this._wrapForEmployee = wrapForEmployee
  this._shouldForwardToEmployee = shouldForwardToEmployee
  this._shouldForwardFromEmployee = shouldForwardFromEmployee
  // const assignRMModel = createAssignRMModel({ productsAPI })
  const assignRMModel = productsAPI.models.all[ASSIGN_RM]

  this.bot = productsAPI.bot
  productsAPI.on('bot', botInstance => this.bot = botInstance)
  productsAPI.addProducts({
    products: ['tradle.EmployeeOnboarding']
  })

  this.models = productsAPI.models.all
  this.privateModels = productsAPI.models.private
  productsAPI.plugins.use({
    onFormsCollected: this._onFormsCollected,
    willSend: this._willSend,
    didSend: this._didSend
    // willSign: setEntityRole
  })

  // prepend
  productsAPI.plugins.use({
    onmessage: this._onmessage,
    deduceApplication: this._deduceApplication
  }, true)

  productsAPI.plugins.use({
    didApproveApplication: ({ req }, certificate) => {
      if (certificate[TYPE] == EMPLOYEE_PASS) {
        this._addEmployeeRole(req.user)
      }
    }
  })
}

const proto = EmployeeManager.prototype

proto._deduceApplication = function _deduceApplication (req) {
  const { message } = req
  if (message && message.forward) {
    // ignore
    return false
  }
}

/**
 * Attempt to detect the employee to forward the message to based on the "context"
 *
 */
proto._maybeForwardByContext = co(function* ({ req }) {
  const { user, context } = req
  // don't forward employee to employee
  if (!context || this.isEmployee(user)) return

  const { bot } = this
  let last
  try {
    last = yield this._getLastInboundMessageByContext({ user, context })
  } catch (err) {
    debug('failed to determine forward target by context', err.message)
    return
  }

  debug(`found forward target candidate ${JSON.stringify(last)} by context ${context}`)
  const { _author } = last
  const candidate = yield bot.users.get(_author)
  if (!this.isEmployee(candidate)) return

  const type = req.message.object[TYPE]
  debug('forwarding')
  debugObj({
    to: 'guessed employee based on context',
    type,
    context,
    author: user.id,
    recipient: candidate.id
  })

  yield this.forwardToEmployee({
    req,
    to: candidate.id,
    other: { context }
  })
})

proto._getLastInboundMessageByContext = co(function* ({ user, context }) {
  if (this.models['tradle.Message'].isInterface) {
    const results = yield this.bot.messages.inbox.find({
      IndexName: 'context',
      KeyConditionExpression: '#context = :context',
      FilterExpression: '#author <> :author',
      ExpressionAttributeNames: {
        '#context': 'context',
        '#author': '_author'
      },
      ExpressionAttributeValues: {
        ':context': context,
        ':author': user.id
      },
      ScanIndexForward: false,
      Limit: 10
    })

    if (!results.length) {
      throw new Error('NotFound')
    }

    return results[0]
  }

  return yield this.bot.db.findOne({
    select: ['_author'],
    filter: {
      EQ: {
        [TYPE]: 'tradle.Message',
        _inbound: true,
        context
      },
      NEQ: {
        _author: user.id
      }
    },
    orderBy: {
      property: 'time',
      desc: true
    }
  })
})

proto._maybeForwardToOrFromEmployee = co(function* ({ req, forward }) {
  const { bot } = this
  const { user, message } = req
  const { object } = message
  const type = object[TYPE]
  if (this.isEmployee(user)) {
    const myIdentity = yield this.bot.getMyIdentity()
    if (myIdentity._permalink === forward) {
      debug(`not forwarding ${type} ${object._link} to self`)
      return
    }

    const shouldForward = yield Promise.resolve(
      this._shouldForwardFromEmployee({ req })
    )

    if (!shouldForward) {
      debug(`not forwarding ${type} from employee ${user.id} to ${forward}`)
      return
    }

    debug('forwarding')
    debugObj({
      to: 'customer (specified by employee in message.forward)',
      type: type,
      context: message.context,
      author: user.id,
      recipient: forward
    })

    yield this.reSignAndForward({ req, to: forward, myIdentity })
    return
  }

  let recipient
  try {
    recipient = yield bot.users.get(forward)
  } catch (err) {
    debug(`final recipient ${forward} specified in "forward" was not found`)
    return
  }

  if (!this.isEmployee(recipient)) {
    debug(`refusing to forward: neither sender "${user.id}" nor recipient "${forward}" is an employee`)
    return
  }

  const shouldForward = yield Promise.resolve(
    this._shouldForwardToEmployee({ req })
  )

  if (!shouldForward) {
    debug(`not forwarding ${type} from ${user.id} to employee ${forward}`)
    return
  }

  debug('forwarding')
  debugObj({
    to: 'employee (specified in message.forward)',
    type: type,
    context: message.context,
    author: user.id,
    recipient: forward
  })

  // don't unwrap-and-re-sign
  yield this.forwardToEmployee({ req, to: forward })
  // yield this.reSignAndForward({ req, to: forward })
})

proto.reSignAndForward = co(function* ({ req, to, myIdentity }) {
  const { user, message } = req
  let { object } = message
  const type = object[TYPE]
  if (myIdentity._permalink == object._author) {
    debug('not re-signing, as original is also signed by me')
  } else {
    debug(`re-signing ${type} before forwarding to ${to}`)
    object = yield this.bot.reSign(object)
    buildResource.setVirtual(object, {
      _time: object.time || Date.now()
    })

    yield this.bot.db.put(object)
  }

  const other = {
    originalSender: user.id
  }

  if (message.context) {
    other.context = message.context
  }

  return this.productsAPI.send({ req, object, to, other })
})

proto._maybeAssignRM = co(function* ({ req, assignment }) {
  const { bot, productsAPI } = this
  const { user, application } = req
  if (!this.isEmployee(user)) {
    debug(`refusing to assign relationship manager as sender "${user.id}" is not an employee`)
    return
  }

  const relationshipManager = parseStub(assignment.employee).permalink
  const applicationResource = yield productsAPI.getApplicationByStub(assignment.application)
  const applicant = parseStub(applicationResource.applicant).permalink
  yield this.assignRelationshipManager({
    req,
    applicant,
    relationshipManager: relationshipManager === user.id ? user : relationshipManager,
    application: applicationResource
  })
})

proto.approveOrDeny = co(function* ({ req, approvedBy, application, judgment }) {
  const { bot, productsAPI } = this
  // TODO: maybe only relationship manager or someone with the right role
  // should be able to perform these actions
  const approve = judgment[TYPE] === APPROVED

  let willSave
  if (!application) {
    application = yield productsAPI.getApplicationByStub(judgment.application)
    willSave = true
  }

  const applicantPermalink = parseStub(application.applicant).permalink
  if (applicantPermalink === approvedBy.id) {
    debug('applicant cannot approve/deny their own application')
    return
  }

  const applicant = yield bot.users.get(applicantPermalink)
  const opts = { req, user: applicant, application }
  if (approve) {
    yield productsAPI.approveApplication(opts)
  } else {
    yield productsAPI.denyApplication(opts)
  }

  const saveApplication = willSave
    ? productsAPI.saveNewVersionOfApplication({
        user: applicant,
        application
      })
    : RESOLVED

  const saveUser = bot.users.merge(applicant)
  yield [saveApplication, saveUser]
})

proto._onmessage = co(function* (req) {
  const { user, application, message } = req
  debug('processing message, custom props:',
    JSON.stringify(pick(message, ['originalSender', 'forward'])))

  const { object, forward } = message
  const type = object[TYPE]
  // forward from employee to customer
  if (this.isEmployee(user)) {
    if (type === APPROVED || type === DENIAL) {
      yield this.approveOrDeny({
        req,
        approvedBy: user,
        application,
        judgment: object
      })

      return
    }

    // assign relationship manager
    if (type === ASSIGN_RM) {
      yield this._maybeAssignRM({ req, assignment: object })
      return
    }

    if (type === SHARE_REQUEST) {
      yield this._onShareRequest({ req })
      return
    }
  }

  if (forward) {
    yield this._maybeForwardToOrFromEmployee({ req, forward })
    // prevent default processing
    debug('preventing further processing of inbound message')
    return false
  }

  if (!application) {
    yield this._maybeForwardByContext({ req })
    return
  }

  // forward from customer to relationship manager
  const { relationshipManager } = application
  if (relationshipManager) {
    const rmPermalink = parseStub(relationshipManager).permalink
    debug('forwarding')
    debugObj({
      to: 'rm',
      type,
      context: message.context,
      author: user.id,
      recipient: rmPermalink
    })

    yield this.forwardToEmployee({
      req,
      to: rmPermalink
    })
  }
})

proto._onShareRequest = function ({ req }) {
  const { user, object, message } = req
  debug(`processing ${SHARE_REQUEST}`, JSON.stringify(object, null, 2))
  const other = {
    originalSender: user.id
  }

  if (message.context) other.context = message.context

  return Promise.all(object.links.map(link => {
    return Promise.all(object.with.map(identityStub => {
      const { permalink } = parseStub(identityStub)
      debug(`sharing ${link} with ${permalink}`)
      return this.productsAPI.send({
        req,
        to: permalink,
        link,
        other
      })
    }))
  }))
}

proto.forwardToEmployee = function forwardToEmployee ({ req, object, to, other={} }) {
  // const other = getCustomMessageProperties(message)
  // delete other.forward
  const { user, message } = req
  if (!object) {
    object = this._wrapForEmployee ? message : message.object
  }

  if (!other.context && message.context) {
    debug(`propagating context ${message.context} on forwarded message`)
    other.context = message.context
  }

  other.originalSender = user.id
  return this.productsAPI.send({ req, to, object, other })
}

proto.hasEmployees = function hasEmployees () {
  return this.listEmployees({ limit: 1 })
    .then(items => items.length > 0)
}

proto.list =
proto.listEmployees = co(function* (opts={}) {
  const { limit } = opts
  const { items } = yield this.bot.db.find({
    filter: {
      EQ: {
        [TYPE]: EMPLOYEE_PASS,
      },
      NEQ: {
        revoked: true
      }
    },
    limit
  })

  return items || []
})

proto.assignRelationshipManager = co(function* ({
  req,
  applicant,
  relationshipManager,
  application
}) {
  const { bot, productsAPI } = this
  const rmID = relationshipManager.id || relationshipManager
  if (application.relationshipManager === rmID) {
    return
  }

  ;[applicant, relationshipManager] = yield [
    applicant,
    relationshipManager
  ].map(userOrId => {
    return typeof userOrId === 'string'
      ? bot.users.get(userOrId)
      : Promise.resolve(userOrId)
  })

  debug(`assigning relationship manager ${rmID} to user ${applicant.id}`)
  if (application.relationshipManager) {
    debug(`previous relationship manager: ${parseStub(application.relationshipManager).permalink}`)
  }

  application.relationshipManager = relationshipManager.identity

  const promiseIntro = this.mutuallyIntroduce({ req, a: applicant, b: relationshipManager })
  const promiseSaveApplication = productsAPI.saveNewVersionOfApplication({
    user: applicant,
    application
  })

  yield [
    promiseIntro,
    promiseSaveApplication
  ]
})

// auto-approve first employee
proto._onFormsCollected = co(function* (req) {
  const { user, application } = req
  if (this.isEmployee(user) || application.requestFor !== EMPLOYEE_ONBOARDING) {
    return
  }

  let approve = this._approveAll
  if (!approve) {
    const hasAtLeastOneEmployee = yield this.hasEmployees()
    approve = !hasAtLeastOneEmployee
  }

  if (approve) {
    return this.hire(req)
  }
})

// function setEntityRole (object) {
//   if (object[TYPE] === EMPLOYEE_PASS) {
//     object.entityRole = 'unspecified'
//   }
// }

// const defaultOnFormsCollected = productsAPI.removeDefaultHandler('onFormsCollected')

proto.hire = function hire (req) {
  const { bot, productsAPI } = this
  let { user, application } = req
  if (this.isEmployee(user)) {
    debug(`user ${user.id} is already an employee`)
    return
  }

  if (!application) {
    application = productsAPI.state.getApplicationsByType(
      user.applications,
      EMPLOYEE_ONBOARDING
    )[0]

    if (!application) {
      throw new Error(`user ${user.id} has no ${EMPLOYEE_ONBOARDING} application`)
    }
  }

  return productsAPI.approveApplication({ req })
}

proto.fire = function fire (req) {
  const { bot, productsAPI } = this
  let { user, application } = req
  if (!this.isEmployee(user)) {
    throw new Error(`user ${user.id} is not an employee`)
  }

  if (application) {
    application = user.applicationsApproved
      .find(app => app._permalink === application._permalink)
  } else {
    application = user.applicationsApproved
      .find(app => app.requestFor === EMPLOYEE_ONBOARDING)
  }

  if (!this.isEmployee(user)) {
    throw new Error(`user ${user.id} is not an employee`)
  }

  removeEmployeeRole(user)
  return productsAPI.revokeCertificate({ user, application })
}

proto.mutuallyIntroduce = co(function* ({ req, a, b }) {
  const { bot, productsAPI } = this
  const aPermalink = a.id || a
  const bPermalink = b.id || b
  const getUserA = typeof a === 'string' ? bot.users.get(a) : a
  const getUserB = typeof b === 'string' ? bot.users.get(b) : b
  const [aIdentity, bIdentity] = yield [
    bot.addressBook.byPermalink(aPermalink),
    bot.addressBook.byPermalink(bPermalink)
  ]

  const [userA, userB] = yield [getUserA, getUserB]
  const introduceA = this._createIntroductionFor({ user: a, identity: aIdentity })
  const introduceB = this._createIntroductionFor({ user: b, identity: bIdentity })
  yield [
    productsAPI.send({ req, to: userA, object: introduceB }),
    productsAPI.send({ req, to: userB, object: introduceA })
  ]
})

proto._willSend = function _willSend (opts) {
  const { req, other={} } = opts
  const { message } = req
  const originalSender = message && message.originalSender
  if (originalSender) {
    debug('setting "forward" based on original sender')
    other.forward = originalSender
    // in case it was null
    opts.other = other
  }
}

// forward any messages sent by the bot
// to the relationship manager
proto._didSend = co(function* (input, sentObject) {
  let { req, to, other={} } = input
  const { user, message, application } = req
  if (!application) return

  let { relationshipManager } = application
  if (!relationshipManager) return

  relationshipManager = parseStub(relationshipManager).permalink
  // avoid infinite loop of sending to the same person
  // and then forwarding, and then forwarding, and then forwarding...
  if (to === relationshipManager) return

  const { originalSender } = other
  if (originalSender === relationshipManager) return

  debug('forwarding')
  debugObj({
    type: sentObject[TYPE],
    to: 'rm',
    author: 'this bot',
    recipient: relationshipManager,
    originalRecipient: req.user.id
  })

  other = shallowClone(other)
  other.originalRecipient = to.id || to
  // nothing to unwrap here, this is an original from our bot
  yield this.forwardToEmployee({
    req,
    other,
    object: sentObject,
    to: relationshipManager
  })
})

proto._addEmployeeRole = function _addEmployeeRole (user) {
  const employeeRole = buildResource.enumValue({
    model: this.privateModels.role,
    value: 'employee'
  })

  user.roles.push(employeeRole)
  return employeeRole
}

proto._createIntroductionFor = function _createIntroductionFor ({ user, identity }) {
  const intro = {
    identity: buildResource.omitVirtual(identity)
  }

  if (user.profile) {
    intro.profile = user.profile
  }

  return buildResource({
    models: this.models,
    model: INTRODUCTION,
    resource: intro
  })
  .toJSON()
}

proto.isEmployee = function isEmployee (user) {
  const { id } = buildResource.enumValue({
    model: this.privateModels.role,
    value: 'employee'
  })

  return user.roles && user.roles.some(role => role.id === id)
}

function removeEmployeeRole (user) {
  const idx = (user.roles || []).find(role => role.id === 'employee')
  if (idx !== -1) {
    user.roles.splice(idx, 1)
    return true
  }
}
