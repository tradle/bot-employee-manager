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

const PACKAGE_NAME = require('./package').name
const EMPLOYEE_ONBOARDING = 'tradle.EmployeeOnboarding'
const EMPLOYEE_PASS = 'tradle.MyEmployeeOnboarding'
const ASSIGN_RM = 'tradle.AssignRelationshipManager'
const APPROVED = 'tradle.ApplicationApproval'
const DENIAL = 'tradle.ApplicationDenial'
const INTRODUCTION = 'tradle.Introduction'
const RESOLVED = Promise.resolve()
// const createAssignRMModel = require('./assign-rm-model')

exports = module.exports = function createEmployeeManager (opts) {
  return new EmployeeManager(opts)
}

function EmployeeManager ({
  productsAPI,
  approveAll,
  wrapForEmployee
}) {
  bindAll(this)

  // assign relationship manager to customers
  // forward messages between customer and relationship manager
  this.productsAPI = productsAPI
  this._approveAll = approveAll
  this._wrapForEmployee = wrapForEmployee
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

proto._maybeForwardToOrFromEmployee = co(function* ({ req, forward }) {
  const { bot } = this
  const { user, message } = req
  const { object } = message
  const type = object[TYPE]
  if (this.isEmployee(user)) {
    const me = yield this.bot.getMyIdentity()
    if (me._permalink === forward) {
      debug(`not forwarding ${type} ${object._link} to self`)
      return
    }

    debug(`forwarding ${type} from employee ${user.id} to ${forward}`)
    yield this.reSignAndForward({ req, to: forward })
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

  debug(`forwarding ${type} from ${user.id} to employee ${forward}`)
  // don't unwrap-and-re-sign
  yield this.forwardToEmployee({ req, to: forward })
  // yield this.reSignAndForward({ req, to: forward })
})

proto.reSignAndForward = co(function* ({ req, to }) {
  const { user, message } = req
  const object = yield this.bot.reSign(message.object)
  const type = object[TYPE]
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
  debug(`assigning relationship manager ${relationshipManager} to user ${applicant}`)
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
  }

  if (forward) {
    yield this._maybeForwardToOrFromEmployee({ req, forward })
    // prevent default processing
    debug('preventing further processing of inbound message')
    return false
  }

  if (!application) return

  // forward from customer to relationship manager
  const { relationshipManager } = application
  if (relationshipManager) {
    const rmPermalink = parseStub(relationshipManager).permalink
    debug(`forwarding ${type} to relationship manager ${rmPermalink}`)
    yield this.forwardToEmployee({
      req,
      to: rmPermalink
    })
  }
})

proto.forwardToEmployee = function forwardToEmployee ({ req, object, to, other={} }) {
  // const other = getCustomMessageProperties(message)
  // delete other.forward
  const { user, message } = req
  if (!object) {
    object = this._wrapForEmployee ? message : message.object
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
    type: EMPLOYEE_PASS,
    filter: {
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
