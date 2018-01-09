const co = require('co').wrap
const _ = require('lodash')
const { TYPE } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const { parseId, parseStub } = require('@tradle/validate-resource').utils
const baseModels = require('@tradle/models').models
const {
  debug,
  getCustomMessageProperties,
  bindAll,
  uniqueStrings
} = require('./utils')

const PACKAGE_NAME = require('./package').name
const EMPLOYEE_ONBOARDING = 'tradle.EmployeeOnboarding'
const EMPLOYEE_PASS = 'tradle.MyEmployeeOnboarding'
const ASSIGN_RM = 'tradle.AssignRelationshipManager'
const APPROVAL = 'tradle.ApplicationApproval'
const DENIAL = 'tradle.ApplicationDenial'
const IDENTITY = 'tradle.Identity'
const INTRODUCTION = 'tradle.Introduction'
const SHARE_REQUEST = 'tradle.ShareRequest'
const VERIFICATION = 'tradle.Verification'
const APPLICATION = 'tradle.Application'
const ACTION_TYPES = [
  ASSIGN_RM,
  VERIFICATION,
  APPROVAL,
  DENIAL
]

const assignRMModel = baseModels[ASSIGN_RM]
const roleModel = require('@tradle/models-products-bot')['tradle.products.Role']
const isActionType = type => ACTION_TYPES.includes(type)
const RESOLVED = Promise.resolve()
// const createAssignRMModel = require('./assign-rm-model')
const alwaysTrue = () => true
const defaultLogger = {
  debug,
  log: debug,
  error: debug,
  warn: debug,
  info: debug
}

exports = module.exports = function createEmployeeManager (opts) {
  return new EmployeeManager(opts)
}

function EmployeeManager ({
  bot,
  productsAPI,
  approveAll,
  wrapForEmployee,
  logger,
  shouldForwardFromEmployee=alwaysTrue,
  shouldForwardToEmployee=alwaysTrue,
  handleMessages=true
}) {
  bindAll(this)

  // assign relationship manager to customers
  // forward messages between customer and relationship manager
  this.productsAPI = productsAPI
  this.logger = logger || defaultLogger
  this._approveAll = approveAll
  this._wrapForEmployee = wrapForEmployee
  this._shouldForwardToEmployee = shouldForwardToEmployee
  this._shouldForwardFromEmployee = shouldForwardFromEmployee
  // const assignRMModel = createAssignRMModel({ productsAPI })

  this.bot = bot
  productsAPI.addProducts({
    products: ['tradle.EmployeeOnboarding']
  })

  this._pluginSubscriptions = []
  this._handlingMessages = false
  if (handleMessages) this.handleMessages()
}

const proto = EmployeeManager.prototype

proto.handleMessages = function handleMessages (handle=true) {
  if (this._handlingMessages === handle) return

  this._handlingMessages = handle
  const { productsAPI } = this

  if (handle === false) {
    this._pluginSubscriptions.forEach(unsubscribe => unsubscribe())
    return
  }

  this._pluginSubscriptions = [
    productsAPI.plugins.use({
      onFormsCollected: this._onFormsCollected,
      willSend: this._willSend,
      didSend: this._didSend
      // willSign: setEntityRole
    }),

    // prepend
    productsAPI.plugins.use({
      onmessage: this._onmessage,
      deduceApplication: this._deduceApplication
    }, true),

    productsAPI.plugins.use({
      didApproveApplication: ({ user, application }, certificate) => {
        if (certificate[TYPE] == EMPLOYEE_PASS) {
          this._addEmployeeRole(user)
        }
      }
    })
  ]
}

proto._deduceApplication = co(function* (req) {
  const { user, message={} } = req
  if (!this.isEmployee(user)) return

  const { context, forward, object } = message
  const type = object[TYPE]
  if (type === ASSIGN_RM) {
    return yield this.productsAPI.getApplicationByStub(object.application)
  }

  const isAction = isActionType(type)
  if (forward && !isAction) {
    // ignore
    return false
  }

  if (!(context && isAction)) return

  try {
    return yield this.bot.db.findOne({
      filter: {
        EQ: {
          [TYPE]: APPLICATION,
          context: req.context
        }
      }
    })
  } catch (err) {
    this.logger.debug('failed to get application by context', err.stack)
  }
})

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
    this.logger.debug('failed to determine forward target by context', err.message)
    return
  }

  this.logger.debug(`found forward target candidate ${JSON.stringify(last)} by context ${context}`)
  const { _author } = last
  const candidate = yield bot.users.get(_author)
  if (!this.isEmployee(candidate)) return

  const type = req.message.object[TYPE]
  this.logger.debug('forwarding', {
    to: 'guessed employee based on context',
    type,
    context,
    author: user.id,
    recipient: candidate.id
  })

  yield this.forwardToEmployee({
    req,
    to: candidate,
    other: { context }
  })
})

proto._getLastInboundMessageByContext = co(function* ({ user, context }) {
  // if (models['tradle.Message'].isInterface) {
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
  // }

  // return yield this.bot.db.findOne({
  //   select: ['_author'],
  //   filter: {
  //     EQ: {
  //       [TYPE]: 'tradle.Message',
  //       _inbound: true,
  //       context
  //     },
  //     NEQ: {
  //       _author: user.id
  //     }
  //   },
  //   orderBy: {
  //     property: 'time',
  //     desc: true
  //   }
  // })
})

proto._maybeForwardToOrFromEmployee = co(function* ({ req, forward }) {
  const { bot } = this
  const { user, message } = req
  const { object } = message
  const type = object[TYPE]
  if (this.isEmployee(user)) {
    const myIdentity = yield this.bot.getMyIdentity()
    if (myIdentity._permalink === forward) {
      this.logger.debug(`not forwarding ${type} ${object._link} to self`)
      return
    }

    const shouldForward = yield Promise.resolve(
      this._shouldForwardFromEmployee({ req })
    )

    if (!shouldForward) {
      this.logger.debug(`not forwarding ${type} from employee ${user.id} to ${forward}`)
      return
    }

    this.logger.debug('forwarding', {
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
    this.logger.debug(`final recipient ${forward} specified in "forward" was not found`)
    return
  }

  if (!this.isEmployee(recipient)) {
    this.logger.debug(`refusing to forward: neither sender "${user.id}" nor recipient "${forward}" is an employee`)
    return
  }

  const shouldForward = yield Promise.resolve(
    this._shouldForwardToEmployee({ req })
  )

  if (!shouldForward) {
    this.logger.debug(`not forwarding ${type} from ${user.id} to employee ${forward}`)
    return
  }

  this.logger.debug('forwarding', {
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
    this.logger.debug('not re-signing, as original is also signed by me')
  } else {
    this.logger.debug(`re-signing ${type} before forwarding to ${to}`)
    const original = object
    object = yield this.bot.reSign(object)
    buildResource.setVirtual(object, {
      _time: object.time || Date.now()
    })

    yield this.bot.db.put(object)
    yield this.bot.db.del(original)
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
  const { user, application, applicant } = req
  if (!this.isEmployee(user)) {
    this.logger.debug(`refusing to assign relationship manager as sender "${user.id}" is not an employee`)
    return
  }

  const relationshipManager = parseStub(assignment.employee).permalink
  yield this.assignRelationshipManager({
    req,
    applicant,
    assignment,
    relationshipManager: relationshipManager === user.id ? user : relationshipManager,
    application
  })
})

proto.approveOrDeny = co(function* ({ req, approvedBy, applicant, application, judgment }) {
  const { bot, productsAPI } = this
  // TODO: maybe only relationship manager or someone with the right role
  // should be able to perform these actions
  const approve = judgment[TYPE] === APPROVAL

  if (!application) {
    application = yield productsAPI.getApplicationByStub(judgment.application)
  }

  const applicantPermalink = parseStub(application.applicant).permalink
  if (applicantPermalink === approvedBy.id) {
    this.logger.debug('applicant cannot approve/deny their own application')
    return
  }

  if (!applicant) applicant = yield bot.users.get(applicantPermalink)

  const opts = { req, user: applicant, application, approvedBy }
  if (approve) {
    yield productsAPI.approveApplication(opts)
  } else {
    yield productsAPI.denyApplication(opts)
  }
})

proto._onmessage = co(function* (req) {
  const { user, application, applicant, message } = req
  this.logger.debug(
    'processing message, custom props:',
    _.pick(message, ['originalSender', 'forward'])
  )

  const { object, forward } = message
  const type = object[TYPE]
  // forward from employee to customer
  if (this.isEmployee(user)) {
    if (application) {
      if (type === APPROVAL || type === DENIAL) {
        yield this.approveOrDeny({
          req,
          approvedBy: user,
          applicant,
          application,
          judgment: object
        })

        return
      }

      if (type === VERIFICATION) {
        // defer to bot-products to import
        return
      }
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
    this.logger.debug('preventing further processing of inbound message')
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
    this.logger.debug('forwarding', {
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
  this.logger.debug(`processing ${SHARE_REQUEST}`, object)
  const other = {
    originalSender: user.id
  }

  if (message.context) other.context = message.context

  return Promise.all(object.links.map(link => {
    return Promise.all(object.with.map(identityStub => {
      const { permalink } = parseStub(identityStub)
      this.logger.debug(`sharing`, {
        link,
        with: permalink
      })

      return this.productsAPI.send({
        req,
        to: permalink,
        link,
        other
      })
    }))
  }))
}

proto.forwardToEmployee = function forwardToEmployee ({ req, object, from, to, other={} }) {
  // const other = getCustomMessageProperties(message)
  // delete other.forward
  let message = req && req.message
  if (!from && req) {
    from = req.user
  }

  if (!object && message) {
    object = this._wrapForEmployee ? message : message.object
  }

  if (!other.context && message && message.context) {
    this.logger.debug(`propagating context ${message.context} on forwarded message`)
    other.context = message.context
  }

  other.originalSender = from.id
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
  assignment,
  application
}) {
  const { bot, productsAPI } = this
  const rmID = relationshipManager.id || relationshipManager
  const currentRM = application.relationshipManager
  if (currentRM === rmID) {
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

  this.logger.debug(`assigning relationship manager ${rmID} to user ${applicant.id}`)
  if (application.relationshipManager) {
    this.logger.debug(`previous relationship manager: ${parseStub(application.relationshipManager).permalink}`)
  }

  application.relationshipManager = relationshipManager.identity

  const { context } = application
  // const promiseFireRM = currentRM ? productsAPI.send({
  //   req,
  //   to: currentRM,
  //   object:
  // }) : RESOLVED

  const promiseIntro = this.mutuallyIntroduce({
    req,
    a: applicant,
    b: relationshipManager,
    context
  })

  const promiseSendVerification = productsAPI.send({
    req,
    to: relationshipManager,
    object: buildResource({
        models: baseModels,
        model: VERIFICATION
      })
      .set({
        document: assignment,
        dateVerified: Date.now()
      })
      .toJSON(),
    other: { context }
  })

  yield [
    promiseIntro,
    promiseSendVerification
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

proto.hire = function hire ({ user, application }) {
  const { bot, productsAPI } = this
  if (this.isEmployee(user)) {
    this.logger.debug(`user ${user.id} is already an employee`)
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

  return productsAPI.approveApplication({ user, application })
}

proto.fire = function fire ({ user, application }) {
  const { bot, productsAPI } = this
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

proto.mutuallyIntroduce = co(function* ({ req, a, b, context }) {
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
    productsAPI.send({
      req,
      to: userA,
      object: introduceB,
      other: { context }
    }),
    productsAPI.send({
      req,
      to: userB,
      object: introduceA,
      other: { context }
    })
  ]
})

proto._willSend = function _willSend (opts) {
  const { req={}, other={} } = opts
  const { message={} } = req
  const { originalSender } = message
  if (originalSender) {
    this.logger.debug('setting "forward" based on original sender')
    other.forward = originalSender
    // in case it was null
    opts.other = other
  }
}

// forward any messages sent by the bot
// to the relationship manager
proto._didSend = co(function* (input, sentObject) {
  if (sentObject[TYPE] === INTRODUCTION) return

  const { application } = input
  if (!application) return

  let { relationshipManager } = application
  if (!relationshipManager) return

  let { req, to, other={} } = input

  relationshipManager = parseStub(relationshipManager).permalink
  // avoid infinite loop of sending to the same person
  // and then forwarding, and then forwarding, and then forwarding...
  if (other.originalSender === relationshipManager) return

  const originalRecipient = to.id || to
  if (originalRecipient === relationshipManager) return

  this.logger.debug(`cc'ing`, {
    type: sentObject[TYPE],
    to: 'rm',
    author: 'this bot',
    recipient: relationshipManager,
    originalRecipient
  })

  other = _.clone(other)
  other.originalRecipient = originalRecipient
  // nothing to unwrap here, this is an original from our bot
  yield this.forwardToEmployee({
    req,
    from: to,
    other,
    object: sentObject,
    to: relationshipManager
  })
})

proto._addEmployeeRole = function _addEmployeeRole (user) {
  const employeeRole = buildResource.enumValue({
    model: roleModel,
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
    models: baseModels,
    model: INTRODUCTION,
    resource: intro
  })
  .toJSON()
}

proto.isEmployee = function isEmployee (user) {
  const { id } = buildResource.enumValue({
    model: roleModel,
    value: 'employee'
  })

  return user.roles && user.roles.some(role => role.id === id)
}

proto.haveAllSubmittedFormsBeenManuallyApproved = co(function* ({ application }) {
  if (!this.productsAPI.haveAllSubmittedFormsBeenVerified({ application })) {
    return false
  }

  const { forms=[], verificationsImported=[] } = application
  const info = verificationsImported.map(({ item, verification }) => {
    return {
      form: item,
      verifier: verification._verifiedBy
    }
  })

  const verifierPermalinks = uniqueStrings(info.map(({ verifier }) => verifier))
  const verifiers = yield verifierPermalinks.map(_permalink => {
    return this.bot.db.get({
      [TYPE]: IDENTITY,
      _permalink
    })
  })

  const employees = verifiers.filter(user => this.isEmployee(user))
  return forms.every(form => {
    return verificationsImported
      .filter(({ item }) => item.id === form.id)
      .find(({ _verifiedBy }) => employees.find(user => user.id === _verifiedBy))
  })
})

function removeEmployeeRole (user) {
  const idx = (user.roles || []).find(role => role.id === 'employee')
  if (idx !== -1) {
    user.roles.splice(idx, 1)
    return true
  }
}
