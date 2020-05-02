const co = require('co').wrap
const pick = require('lodash/pick')
const omit = require('lodash/omit')
const clone = require('lodash/clone')
const extend = require('lodash/extend')

const { TYPE, SIG } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const { buildResourceStub, title } = require('@tradle/build-resource')

const { parseId, parseStub, omitVirtual } = require('@tradle/validate-resource').utils
const models = require('./models')
const {
  debug,
  // getCustomMessageProperties,
  bindAll,
  uniqueStrings,
  getUserIdentityStub,
  getPermalinkFromStub,
  createIntroductionToUser,
  createVerificationForDocument,
  removeEmployeeRole,
  defaultLogger
} = require('./utils')

const PACKAGE_NAME = require('./package').name
const {
  EMPLOYEE_ONBOARDING,
  EMPLOYEE_PASS,
  ASSIGN_RM,
  APPROVAL,
  DENIAL,
  IDENTITY,
  INTRODUCTION,
  SHARE_REQUEST,
  VERIFICATION,
  APPLICATION,
  FORM_REQUEST,
  FORM_ERROR,
  SIMPLE_MESSAGE,
  REQUEST_ERROR,
  CHECK_OVERRIDE,
  CE_NOTIFICATION
} = require('./types')

const ACTION_TYPES = [ASSIGN_RM, VERIFICATION, APPROVAL, DENIAL]

const notNull = x => x != null
const assignRMModel = models[ASSIGN_RM]
const roleModel = require('@tradle/models-products-bot')['tradle.products.Role']
const isActionType = type => ACTION_TYPES.includes(type)
const RESOLVED = Promise.resolve()
// const createAssignRMModel = require('./assign-rm-model')
const alwaysTrue = () => true
const ORDER_BY_TIME_DESC = {
  property: '_time',
  desc: true
}

exports = module.exports = function createEmployeeManager (opts) {
  return new EmployeeManager(opts)
}

exports.isEmployee = isEmployee

function isEmployee ({ user, masterUser }) {
  let realUsers = [user, masterUser].filter(value => value)
  const { id } = buildResource.enumValue({
    model: roleModel,
    value: 'employee'
  })
  return realUsers.some(user => user.roles && user.roles.some(role => role.id === id))
}

function EmployeeManager ({
  bot,
  productsAPI,
  approveAll,
  wrapForEmployee,
  logger = defaultLogger,
  shouldForwardFromEmployee = alwaysTrue,
  shouldForwardToEmployee = alwaysTrue,
  handleMessages = true
}) {
  bindAll(this)

  // assign relationship manager to customers
  // forward messages between customer and relationship manager
  this.productsAPI = productsAPI
  this.logger = logger
  this._approveAll = approveAll
  this._wrapForEmployee = wrapForEmployee
  this._shouldForwardToEmployee = shouldForwardToEmployee
  this._shouldForwardFromEmployee = shouldForwardFromEmployee
  // const assignRMModel = createAssignRMModel({ productsAPI })

  this.bot = bot
  this._pluginSubscriptions = []
  this._handlingMessages = false
  if (handleMessages) this.handleMessages()
}

const proto = EmployeeManager.prototype

proto.handleMessages = function handleMessages (handle = true) {
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
    productsAPI.plugins.use(
      {
        onmessage: this._onmessage,
        deduceApplication: this._deduceApplication
      },
      true
    ),

    productsAPI.plugins.use({
      didApproveApplication: ({ req, user, application }, certificate) => {
        if (certificate[TYPE] == EMPLOYEE_PASS) {
          this._addEmployeeRole(user)
        }
      }
    })
  ]
}

proto._deduceApplication = co(function*(req) {
  const { message = {} } = req
  if (!this.isEmployee(req)) return

  const { context, forward, object } = message
  const type = object[TYPE]
  if (
    type === ASSIGN_RM ||
    type == APPROVAL ||
    type === DENIAL ||
    type === CE_NOTIFICATION ||
    this.bot.models[type].subClassOf === CHECK_OVERRIDE
  ) {
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
          context
        }
      },
      orderBy: ORDER_BY_TIME_DESC
    })
  } catch (err) {
    this.logger.debug('failed to get application by context', {
      error: err.stack,
      context
    })
  }
})

/**
 * Attempt to detect the employee to forward the message to based on the "context"
 *
 */
proto._maybeForwardByContext = co(function*({ req }) {
  const { user, context } = req
  // don't forward employee to employee
  if (!context || this.isEmployee(req)) return

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
  if (!this.isEmployee({ user: candidate })) return

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
    from: req.user,
    to: candidate,
    other: { context }
  })
})

proto._getLastInboundMessageByContext = co(function*({ user, context }) {
  // if (models['tradle.Message'].isInterface) {
  // const results = yield this.bot.messages.inbox.find({
  //   IndexName: 'context',
  //   KeyConditionExpression: '#context = :context',
  //   FilterExpression: '#author <> :author',
  //   ExpressionAttributeNames: {
  //     '#context': 'context',
  //     '#author': '_author'
  //   },
  //   ExpressionAttributeValues: {
  //     ':context': context,
  //     ':author': user.id
  //   },
  //   ScanIndexForward: false,
  //   Limit: 10
  // })

  // if (!results.length) {
  //   throw new Error('NotFound')
  // }

  // return results[0]
  // }

  return yield this.bot.db.findOne({
    select: ['_author'],
    filter: {
      EQ: {
        [TYPE]: 'tradle.Message',
        context,
        _inbound: true
      },
      NEQ: {
        _author: user.id
      }
    },
    orderBy: ORDER_BY_TIME_DESC
  })
})

proto._maybeForwardToOrFromEmployee = co(function*({ req, forward }) {
  const { bot } = this
  const { user, message } = req
  const { object } = message
  const type = object[TYPE]
  if (this.isEmployee(req)) {
    const myPermalink = yield this.bot.getPermalink()
    if (myPermalink === forward) {
      this.logger.debug(`not forwarding ${type} ${object._link} to self`)
      return
    }

    const shouldForward = yield Promise.resolve(this._shouldForwardFromEmployee({ req }))

    if (!shouldForward) {
      this.logger.debug(`not forwarding ${type} from employee ${user.id} to ${forward}`)
      return
    }

    this.logger.debug('forwarding', {
      to: 'customer (specified by employee in message.forward)',
      type,
      context: message.context,
      author: user.id,
      recipient: forward
    })

    yield this.forward({ req, to: forward })
    return
  }

  let recipient
  try {
    recipient = yield bot.users.get(forward)
  } catch (err) {
    this.logger.debug(`final recipient ${forward} specified in "forward" was not found`)
    return
  }

  if (!this.isEmployee({ user: recipient })) {
    this.logger.debug(
      `refusing to forward: neither sender "${user.id}" nor recipient "${forward}" is an employee`
    )
    return
  }

  const shouldForward = yield Promise.resolve(this._shouldForwardToEmployee({ req }))

  if (!shouldForward) {
    this.logger.debug(`not forwarding ${type} from ${user.id} to employee ${forward}`)
    return
  }

  this.logger.debug('forwarding', {
    to: 'employee (specified in message.forward)',
    type,
    context: message.context,
    author: user.id,
    recipient: forward
  })

  // don't unwrap-and-re-sign
  yield this.forwardToEmployee({
    req,
    from: req.user,
    to: forward
  })
  // yield this.forward({ req, to: forward })
})

proto.forward = co(function*({ req, to }) {
  const { user, message } = req
  const { object } = message
  const other = {
    originalSender: user.id
  }

  if (message.context) {
    other.context = message.context
  }

  return this.productsAPI.send({ req, object, to, other })
})

proto._maybeAssignRM = co(function*({ req, assignment }) {
  const { bot, productsAPI } = this
  let { user, application, applicant } = req
  // if (!this.isEmployee(user)) {
  if (!this.isEmployee(req)) {
    this.logger.debug(
      `refusing to assign relationship manager as sender "${user.id}" is not an employee`
    )
    return
  }

  // const relationshipManager = assignment._masterAuthor || getPermalinkFromStub(assignment.employee)
  const relationshipManager = getPermalinkFromStub(assignment.employee)
  if (!applicant && assignment.application) {
    application = yield bot.getResource(assignment.application)
    // if (!application)
    //   debugger
    ;({ applicant } = application)
      applicant ={ id: applicant._permalink }
      extend(req, { application, applicant })
  }
  if (relationshipManager === applicant.id) {
    this.logger.debug(
      'applicant attempted to become the relationship manager for own application',
      {
        application: application._permalink
      }
    )

    yield this.productsAPI.send({
      req,
      to: user,
      application,
      object: {
        [TYPE]: SIMPLE_MESSAGE,
        message: `You can't be the relationship manager for your own application!`
      }
    })

    return
  }

  yield this.assignRelationshipManager({
    req,
    applicant,
    assignment,
    relationshipManager: relationshipManager === user.id ? user : relationshipManager,
    application
  })
})

proto.approveOrDeny = co(function*({ req, judge, applicant, application, judgment }) {
  const { bot, productsAPI } = this
  // TODO: maybe only relationship manager or someone with the right role
  // should be able to perform these actions
  const approve = judgment[TYPE] === APPROVAL

  if (!application) {
    application = yield productsAPI.getApplicationByStub(judgment.application)
  }

  const applicantPermalink = parseStub(application.applicant).permalink
  if (applicantPermalink === judge.id) {
    this.logger.debug('applicant attempted to approve/deny their own application', {
      application: application._permalink
    })

    yield this.productsAPI.send({
      req,
      to: judge,
      application,
      object: {
        [TYPE]: SIMPLE_MESSAGE,
        message: `You can't approve/deny your own application!`
      }
    })

    return
  }

  if (!applicant) applicant = yield bot.users.get(applicantPermalink)

  const opts = { req, user: applicant, application, judge }
  const verb = approve ? 'approved' : 'denied'
  this.logger.debug(`relationship manager ${verb} application`, {
    relationshipManager: judge.id,
    application: application._permalink
  })

  try {
    if (approve) {
      yield productsAPI.approveApplication(opts)
    } else {
      yield productsAPI.denyApplication(opts)
    }
  } catch (err) {
    switch (err.name) {
      case 'Duplicate':
        yield this.productsAPI.send({
          req,
          to: judge,
          application,
          object: {
            [TYPE]: SIMPLE_MESSAGE,
            message: `This application has already been ${verb}`
          }
        })
        break
      case 'AbortError':
        yield this.productsAPI.send({
          req,
          to: judge,
          application,
          object: {
            [TYPE]: REQUEST_ERROR,
            message: err.message,
            application,
            date: new Date().getTime()
          }
        })
        break
      default:
        throw err
    }
  }
})

proto._onmessage = co(function*(req) {
  let { user, application, applicant, message } = req
  this.logger.debug(
    'processing message, custom props:',
    pick(message, ['originalSender', 'forward'])
  )

  const { object, forward } = message
  const type = object[TYPE]
  // forward from employee to customer

  let isEmployee = this.isEmployee(req)
  if (isEmployee) {
    if (application) {
      if (type === APPROVAL || type === DENIAL) {
        yield this.approveOrDeny({
          req,
          judge: user,
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
  // const { relationshipManagers } = application
  // if (!relationshipManagers) return

  const { analyst } = application
  if (!analyst) return

  const employeePass = yield this.bot.getResource(analyst)
  const employee = employeePass.owner

  // yield relationshipManagers.map(co(function* (stub) {
  yield [employee].map(
    co(function*(stub) {
      const rmPermalink = getPermalinkFromStub(stub)
      this.logger.debug('forwarding', {
        to: 'rm',
        type,
        context: message.context,
        author: user.id,
        recipient: rmPermalink
      })

      yield this.forwardToEmployee({
        req,
        from: req.user,
        to: rmPermalink
      })
    }).bind(this)
  )
})

proto._onShareRequest = function ({ req }) {
  const { user, object, message } = req
  this.logger.debug(`processing ${SHARE_REQUEST}`, object)
  const other = {
    originalSender: user.id
  }

  if (message.context) other.context = message.context

  return Promise.all(
    object.with.map(identityStub => {
      const { permalink } = parseStub(identityStub)
      this.logger.debug(`sharing`, {
        links: object.links,
        with: permalink
      })

      const batch = object.links.map(link => ({
        req,
        to: permalink,
        link,
        other
      }))

      return this.productsAPI.sendBatch(batch)
    })
  )

  // return Promise.all(object.links.map(link => {
  //   return Promise.all(object.with.map(identityStub => {
  //     const { permalink } = parseStub(identityStub)
  //     this.logger.debug(`sharing`, {
  //       link,
  //       with: permalink
  //     })

  //     return this.productsAPI.send({
  //       req,
  //       to: permalink,
  //       link,
  //       other
  //     })
  //   }))
  // }))
}

proto.forwardToEmployee = function forwardToEmployee ({ req, object, from, to, other = {} }) {
  // const other = getCustomMessageProperties(message)
  // delete other.forward
  const message = req && req.message
  if (!object && message) {
    object = this._wrapForEmployee ? message : message.object
  }

  if (!other.context && message && message.context) {
    this.logger.debug(`propagating context ${message.context} on forwarded message`)
    other.context = message.context
  }

  if (from && !other.originalSender) {
    other.originalSender = from.id || from
  }
  // return this.productsAPI.send({ req, to, object, other })

  return this.bot.getResource({ [TYPE]: IDENTITY, _permalink: to, link: to })
    .then(result => {
      let { pubkeys } = result
      let employeeHashes = []
      pubkeys.forEach(pkey => {
        if (pkey.importedFrom)
          employeeHashes.push(pkey.importedFrom)
      })
      if (!employeeHashes.length)
        return this.productsAPI.send({ req, to, object, other })
      return this.productsAPI.send({ req, to, object, other })
      .then(() => Promise.all(employeeHashes.map(to => this.productsAPI.send({ req, to, object, other }))))
    })
}

proto.hasEmployees = function hasEmployees () {
  return this.listEmployees({ limit: 1 }).then(items => items.length > 0)
}

proto.list = proto.listEmployees = co(function*(opts = {}) {
  const { limit } = opts
  const { items } = yield this.bot.db.find({
    filter: {
      EQ: {
        [TYPE]: EMPLOYEE_PASS,
        _author: yield this.bot.getMyPermalink()
      },
      NEQ: {
        revoked: true
      }
    },
    orderBy: {
      property: '_time',
      desc: true
    },
    limit
  })

  return items || []
})

proto.assignRelationshipManager = co(function*({
  req,
  applicant,
  relationshipManager,
  assignment,
  application
}) {
  const { bot, productsAPI } = this
  const rmID = relationshipManager.id || relationshipManager
  const rms = application.analyst // application.relationshipManagers || []

  if (rms && rms === getPermalinkFromStub(rms)) {
    this.logger.debug('ignoring request to assign existing relationship manager')
    return
  }

  // const alreadyAssigned = rms.some(stub => getPermalinkFromStub(stub) === rmID)
  // if (alreadyAssigned) {
  //   this.logger.debug('ignoring request to assign existing relationship manager')
  //   return
  // }

  // ;[applicant, relationshipManager] = yield [
  [applicant, relationshipManager] = yield [applicant, relationshipManager].map(userOrId => {
    if (typeof userOrId === 'string')
      return bot.users.get(userOrId)
    return Promise.resolve(userOrId)
  })

  this.logger.debug(`assigning relationship manager ${rmID} to user ${applicant.id}`)
  const stub = getUserIdentityStub(relationshipManager)

  let masterUser, ownerHash
  if (assignment._masterAuthor)
    ownerHash = assignment._masterAuthor
  else
    ownerHash = stub._permalink

  const employee = yield this.bot.db.findOne({
    filter: {
      EQ: {
        [TYPE]: 'tradle.MyEmployeeOnboarding',
        'owner._permalink': ownerHash
      }
    }
  })
  const { analyst } = application
  if (analyst && analyst._link === employee._link) {
    this.logger.debug('ignoring request to assign existing relationship manager')
    return
  }
  application.analyst = buildResourceStub({ resource: employee, models: bot.models })
  // application.reviewer = stub
  // application.relationshipManagers = rms

  const { context } = application

  if (assignment._masterAuthor)
    masterUser = yield bot.users.get(ownerHash)
  else
    masterUser = relationshipManager

  const masterHash = masterUser.id

  const masterIdentity = yield this.bot.addressBook.byPermalink(masterHash)
  const pairedIdentities = []
  masterIdentity.pubkeys.forEach(pub => {
    if (pub.importedFrom) pairedIdentities.push(pub.importedFrom)
  })

  let pairedManagers
  if (pairedIdentities.length)
    pairedManagers = yield Promise.all(pairedIdentities.map(hash => bot.users.get(hash)))

  let promises = []
  if (pairedManagers)
    promises = pairedManagers.map(rm =>
      this.mutuallyIntroduce({
        req,
        a: applicant,
        b: rm,
        context
      })
    )

  const mIntro = this.mutuallyIntroduce({
    req,
    a: applicant,
    b: masterUser,
    context
  })
  const mVerification = productsAPI.send({
    req,
    to: masterUser,
    object: createVerificationForDocument(assignment),
    other: { context }
  })
  yield [mIntro, mVerification].concat(pairedManagers || [])
})
// auto-approve first employee
proto._onFormsCollected = co(function*({ req, user, application }) {
  if (this.isEmployee(req) || application.requestFor !== EMPLOYEE_ONBOARDING) {
    return
  }

  let approve = this._approveAll
  if (!approve) {
    const hasAtLeastOneEmployee = yield this.hasEmployees()
    approve = !hasAtLeastOneEmployee
  }

  if (approve) {
    return this.hire({ req, user, application })
  }
})

// function setEntityRole (object) {
//   if (object[TYPE] === EMPLOYEE_PASS) {
//     object.entityRole = 'unspecified'
//   }
// }

// const defaultOnFormsCollected = productsAPI.removeDefaultHandler('onFormsCollected')

proto.hire = function hire ({ req, user, application }) {
  const { productsAPI } = this
  if (this.isEmployee(req)) {
    this.logger.debug(`user ${user.id} is already an employee`)
    return
  }

  if (!application) {
    application = productsAPI.state.getApplicationsByType(user.applications, EMPLOYEE_ONBOARDING)[0]

    if (!application) {
      throw new Error(`user ${user.id} has no ${EMPLOYEE_ONBOARDING} application`)
    }
  }

  this.logger.debug('approving application for employee', {
    application: application._permalink
  })

  return productsAPI.approveApplication({ req, user, application })
}

proto.fire = function fire ({ req, user, application }) {
  const { productsAPI } = this
  if (!this.isEmployee(req)) {
    throw new Error(`user ${user.id} is not an employee`)
  }

  if (application) {
    application = user.applicationsApproved.find(app => app._permalink === application._permalink)
  } else {
    application = user.applicationsApproved.find(app => app.requestFor === EMPLOYEE_ONBOARDING)
  }

  removeEmployeeRole(user)
  this.logger.debug('revoking application for employee', {
    application: application._permalink
  })

  return productsAPI.revokeCertificate({ req, user, application })
}

proto.mutuallyIntroduce = co(function*({ req, a, b, context }) {
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
  const introduceA = createIntroductionToUser({ user: a, identity: aIdentity })
  const introduceB = createIntroductionToUser({ user: b, identity: bIdentity })
  const other = { context }
  yield [
    productsAPI.send({
      req,
      to: userA,
      object: introduceB,
      other
    }),
    productsAPI.send({
      req,
      to: userB,
      object: introduceA,
      other
    })
  ]
})

proto._willSend = function _willSend (opts) {
  const { req = {}, other = {} } = opts
  const { message = {} } = req
  const { originalSender } = message
  if (originalSender) {
    this.logger.debug('setting "forward" based on original sender', { originalSender })
    other.forward = originalSender
    // in case it was null
    opts.other = other
  }
}

// forward any messages sent by the bot
// to relationship managers
proto._didSend = co(function*(input, sentObject) {
  if (sentObject[TYPE] === INTRODUCTION) return

  const { req, to, application } = input
  if (!application) return

  // const { relationshipManagers } = application
  // if (!(relationshipManagers && relationshipManagers.length)) return

  const { analyst } = application
  if (!analyst) return

  const originalRecipient = to.id || to
  if (originalRecipient !== getPermalinkFromStub(application.applicant)) {
    return
  }

  const other = clone(input.other || {})
  other.originalRecipient = originalRecipient

  const employeePass = yield this.bot.getResource(analyst)
  let employee = employeePass.owner
  const { masterUser, user } = req
  if (employee && masterUser && employee._permalink === masterUser.id)
    employee = user.identity

  // yield relationshipManagers.map(co(function* (stub) {
  yield [employee].map(
    co(function*(stub) {
      const userId = getPermalinkFromStub(stub)
      // avoid infinite loop of sending to the same person
      // and then forwarding, and then forwarding, and then forwarding...
      if (other.originalSender === userId || other.originalRecipient === userId) {
        return
      }

      this.logger.debug(`cc'ing`, {
        type: sentObject[TYPE],
        to: 'rm',
        author: 'this bot',
        recipient: userId,
        originalRecipient: other.originalRecipient
      })

      // nothing to unwrap here, this is an original from our bot
      yield this.forwardToEmployee({
        req,
        other,
        object: sentObject,
        to: userId
      })
    }).bind(this)
  )
})

proto._addEmployeeRole = function _addEmployeeRole (user) {
  const employeeRole = buildResource.enumValue({
    model: roleModel,
    value: 'employee'
  })

  user.roles.push(employeeRole)
  return employeeRole
}

proto.isEmployee = isEmployee

proto.haveAllSubmittedFormsBeenManuallyApproved = co(function*({ application }) {
  const verifications = yield this.productsAPI.getVerifications({ application })
  const formStubs = (application.forms || []).map(appSub => parseStub(appSub.submission))
  const verified = verifications.map(verification => parseStub(verification.document))
  const unverified = formStubs.filter(a => !verified.find(b => a.permalink === b.permalink))
  if (unverified.length) return false

  const verifiersInfo = verifications.map(v => ({
    form: parseStub(v.document),
    verifier: v._verifiedBy
  }))

  const verifierPermalinks = uniqueStrings(verifiersInfo.map(({ verifier }) => verifier))
  const verifiers = yield verifierPermalinks.map(_permalink =>
    this.bot.db.get({
      [TYPE]: IDENTITY,
      _permalink
    })
  )

  const employeeIds = verifiers
    .map((user, i) => this.isEmployee({ user }) && verifierPermalinks[i])
    .filter(notNull)

  return formStubs.every(formStub =>
    verifications
      .filter(v => parseStub(v.document).link === formStub.link)
      .find(({ _verifiedBy }) => employeeIds.includes(_verifiedBy))
  )
})
