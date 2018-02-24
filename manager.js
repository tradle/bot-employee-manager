const co = require('co').wrap
const _ = require('lodash')
const { TYPE, SIG } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const { parseId, parseStub } = require('@tradle/validate-resource').utils
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

const {
  EMPLOYEE_ONBOARDING,
  EMPLOYEE_PASS,
  APPROVAL,
  DENIAL,
  IDENTITY,
  INTRODUCTION
} = require('./types')

const roleModel = require('@tradle/models-products-bot')['tradle.products.Role']

exports = module.exports = function createEmployeeManager (opts) {
  return new EmployeeManager(opts)
}

exports.EmployeeManager = EmployeeManager

function EmployeeManager ({
  bot,
  productsAPI,
  approveAll,
  wrapForEmployee,
  logger=defaultLogger
}) {
  bindAll(this)

  // assign relationship manager to customers
  // forward messages between customer and relationship manager
  this.productsAPI = productsAPI
  this.logger = logger
  this._approveAll = approveAll
  this._wrapForEmployee = wrapForEmployee
  // const assignRMModel = createAssignRMModel({ productsAPI })

  this.bot = bot
}

const proto = EmployeeManager.prototype
proto.getEmployeeFromContext = co(function* ({ user, context }) {
  // don't forward employee to employee
  if (!context || this.isEmployee(user)) return

  const { bot } = this
  let last
  try {
    last = yield this.getLastInboundMessageByContext({ user, context })
  } catch (err) {
    this.logger.debug('failed to determine forward target by context', err.message)
    return
  }

  this.logger.debug(`found forward target candidate ${JSON.stringify(last)} by context ${context}`)
  const { _author } = last
  const candidate = yield bot.users.get(_author)
  if (this.isEmployee(candidate)) return candidate
})

proto.getLastInboundMessageByContext = co(function* ({ user, context }) {
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

proto.reSignAndForward = co(function* ({ req, from, to, message, myIdentity }) {
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

    // otherwise conditional put will fail
    yield this.bot.db.del(original)
    yield this.bot.db.put(object)
  }

  const other = {
    originalSender: from.id
  }

  if (message.context) {
    other.context = message.context
  }

  return this.productsAPI.send({ req, object, to, other })
})

proto.approveOrDeny = co(function* ({ req, judge, applicant, application, judgment }) {
  const { bot, productsAPI } = this
  // TODO: maybe only relationship manager or someone with the right role
  // should be able to perform these actions
  const approve = judgment[TYPE] === APPROVAL

  if (!application) {
    application = yield productsAPI.getApplicationByStub(judgment.application)
  }

  const applicantPermalink = parseStub(application.applicant).permalink
  if (applicantPermalink === judge.id) {
    this.logger.debug('applicant cannot approve/deny their own application')
    return
  }

  if (!applicant) applicant = yield bot.users.get(applicantPermalink)

  const opts = { req, user: applicant, application, judge }
  if (approve) {
    yield productsAPI.approveApplication(opts)
  } else {
    yield productsAPI.denyApplication(opts)
  }
})


proto.share = co(function* ({ req, links, recipients, other={} }) {
  return yield Promise.all(links.map(link => {
    return Promise.all(recipients.map(identityStub => {
      const { permalink } = parseStub(identityStub)
      this.logger.debug(`sharing`, {
        link,
        recipient: permalink
      })

      return this.productsAPI.send({
        req,
        to: permalink,
        link,
        other
      })
    }))
  }))
})

proto.forwardToEmployee = function forwardToEmployee ({ req, object, from, to, other={} }) {
  // const other = getCustomMessageProperties(message)
  // delete other.forward
  let message = req && req.message
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
  const rms = application.relationshipManagers || []
  const alreadyAssigned = rms.some(stub => getPermalinkFromStub(stub) === rmID)
  if (alreadyAssigned) {
    this.logger.debug('ignoring request to assign existing relationship manager')
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
  const stub = getUserIdentityStub(relationshipManager)
  rms.push(stub)
  application.relationshipManagers = rms

  const { context } = application
  const promiseIntro = this.mutuallyIntroduce({
    req,
    a: applicant,
    b: relationshipManager,
    context
  })

  const promiseSendVerification = productsAPI.send({
    req,
    to: relationshipManager,
    object: createVerificationForDocument(assignment),
    other: { context }
  })

  yield [
    promiseIntro,
    promiseSendVerification
  ]
})

// function setEntityRole (object) {
//   if (object[TYPE] === EMPLOYEE_PASS) {
//     object.entityRole = 'unspecified'
//   }
// }

// const defaultOnFormsCollected = productsAPI.removeDefaultHandler('onFormsCollected')

proto.hire = function hire ({ req, user, application }) {
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

  return productsAPI.approveApplication({ req, user, application })
}

proto.fire = function fire ({ req, user, application }) {
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
  return productsAPI.revokeCertificate({ req, user, application })
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

// forward any messages sent by the bot
// to relationship managers
proto.addEmployeeRole = function addEmployeeRole (user) {
  const employeeRole = buildResource.enumValue({
    model: roleModel,
    value: 'employee'
  })

  user.roles.push(employeeRole)
  return employeeRole
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
