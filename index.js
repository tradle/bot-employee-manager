const co = require('co').wrap
const shallowClone = require('xtend')
const { TYPE } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const { parseId, parseStub } = require('@tradle/validate-resource').utils
const {
  debug,
  getCustomMessageProperties
} = require('./utils')

const PACKAGE_NAME = require('./package').name
const STORAGE_KEY = PACKAGE_NAME
const EMPLOYEE_ONBOARDING = 'tradle.EmployeeOnboarding'
const EMPLOYEE_PASS = 'tradle.MyEmployeeOnboarding'
const APPLICATION = 'tradle.Application'
const ASSIGN_RM = 'tradle.AssignRelationshipManager'
const APPROVED = 'tradle.ApplicationApproval'
const DENIAL = 'tradle.ApplicationDenial'
const INTRODUCTION = 'tradle.Introduction'
const RESOLVED = Promise.resolve()
// const createAssignRMModel = require('./assign-rm-model')

exports = module.exports = function createEmployeeManager ({ productsAPI, approveAll }) {
  // assign relationship manager to customers
  // forward messages between customer and relationship manager
  const { namespace, state } = productsAPI
  const { getApplicationsByType } = state
  // const assignRMModel = createAssignRMModel({ productsAPI })
  const assignRMModel = productsAPI.models.all[ASSIGN_RM]

  let { bot } = productsAPI
  productsAPI.on('bot', botInstance => bot = botInstance)
  productsAPI.addProducts({
    products: ['tradle.EmployeeOnboarding']
  })

  const allModels = productsAPI.models.all
  const privateModels = productsAPI.models.private
  const maybeForwardToEmployee = co(function* ({ req, forward }) {
    const { user, message } = req
    const { object } = message
    const type = object[TYPE]
    if (isEmployee(user)) {
      const me = yield bot.getMyIdentity()
      if (me._permalink === forward) {
        debug(`not forwarding ${type} ${object._link} to self`)
        return
      }

      debug(`forwarding ${type} from employee ${user.id} to ${forward}`)
      yield reSignAndForward({ req, to: forward })
      return
    }

    let recipient
    try {
      recipient = yield bot.users.get(forward)
    } catch (err) {
      debug(`final recipient ${forward} specified in "forward" was not found`)
      return
    }

    if (!isEmployee(recipient)) {
      debug(`refusing to forward: neither sender "${user.id}" nor recipient "${forward}" is an employee`)
      return
    }

    debug(`forwarding ${type} from ${user.id} to employee ${forward}`)
    yield reSignAndForward({ req, to: forward })
  })

  const reSignAndForward = co(function* ({ req, to }) {
    const { user, message } = req
    const object = yield bot.reSign(message.object)
    const type = object[TYPE]
    const other = {
      originalSender: user.id
    }

    if (message.context) {
      other.context = message.context
    }

    return productsAPI.send({ req, object, to, other })
  })

  const maybeAssignRM = co(function* ({ req, assignment }) {
    const { user, application } = req
    if (!isEmployee(user)) {
      debug(`refusing to assign relationship manager as sender "${user.id}" is not an employee`)
      return
    }

    const relationshipManager = parseStub(assignment.employee).permalink
    const applicationResource = yield productsAPI.getApplicationByStub(assignment.application)
    const applicant = parseStub(applicationResource.applicant).permalink
    debug(`assigning relationship manager ${relationshipManager} to user ${applicant}`)
    yield assignRelationshipManager({
      req,
      applicant,
      relationshipManager: relationshipManager === user.id ? user : relationshipManager,
      application: applicationResource
    })
  })

  const approveOrDeny = co(function* ({ req, approvedBy, application, judgment }) {
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

  const onmessage = co(function* (req) {
    const { user, application, message } = req
    const { object, forward } = message
    const type = object[TYPE]
    // forward from employee to customer
    if (forward) {
      yield maybeForwardToEmployee({ req, forward })
      // prevent default processing
      return false
    }

    // assign relationship manager
    if (type === ASSIGN_RM) {
      yield maybeAssignRM({ req, assignment: object })
      return
    }

    if (type === APPROVED || type === DENIAL) {
      yield approveOrDeny({
        req,
        approvedBy: user,
        application,
        judgment: object
      })

      return
    }

    if (!application) return

    // forward from customer to relationship manager
    const { relationshipManager } = application
    if (relationshipManager) {
      const rmPermalink = parseStub(relationshipManager).permalink
      debug(`forwarding ${type} to relationship manager ${rmPermalink}`)
      yield forwardMessage({
        req,
        to: rmPermalink
      })
    }
  })

  function forwardMessage ({ req, object, to, other }) {
    // const other = getCustomMessageProperties(message)
    // delete other.forward
    if (!object) object = req.message
    return productsAPI.send({ req, to, object, other })
  }

  function hasEmployees () {
    return listEmployees({ limit: 1 })
      .then(items => items.length > 0)
  }

  const listEmployees = co(function* (opts={}) {
    const { limit } = opts
    const { items } = yield bot.db.find({
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

  const assignRelationshipManager = co(function* ({
    req,
    applicant,
    relationshipManager,
    application
  }) {
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

    buildResource.set({
      models: allModels,
      model: APPLICATION,
      resource: application,
      properties: {
        relationshipManager: relationshipManager.identity
      }
    })

    const promiseIntro = mutuallyIntroduce({ req, a: applicant, b: relationshipManager })
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
  const onFormsCollected = co(function* (req) {
    const { user, application } = req
    if (isEmployee(user) || application.requestFor !== EMPLOYEE_ONBOARDING) {
      return
    }

    let approve = approveAll
    if (!approve) {
      const hasAtLeastOneEmployee = yield hasEmployees()
      approve = !hasAtLeastOneEmployee
    }

    if (approve) {
      return hire(req)
    }
  })

  // function setEntityRole (object) {
  //   if (object[TYPE] === EMPLOYEE_PASS) {
  //     object.entityRole = 'unspecified'
  //   }
  // }

  // const defaultOnFormsCollected = productsAPI.removeDefaultHandler('onFormsCollected')

  function hire (req) {
    let { user, application } = req
    if (isEmployee(user)) {
      debug(`user ${user.id} is already an employee`)
      return
    }

    if (!application) {
      application = getApplicationsByType(user.applications, EMPLOYEE_ONBOARDING)[0]
      if (!application) {
        throw new Error(`user ${user.id} has no ${EMPLOYEE_ONBOARDING} application`)
      }
    }

    addEmployeeRole(user)
    return productsAPI.approveApplication({ req })
  }

  function fire (req) {
    let { user, application } = req
    if (!isEmployee(user)) {
      throw new Error(`user ${user.id} is not an employee`)
    }

    if (application) {
      application = user.applicationsApproved
        .find(app => app._permalink === application._permalink)
    } else {
      application = user.applicationsApproved
        .find(app => app.requestFor === EMPLOYEE_ONBOARDING)
    }

    if (!isEmployee(user)) {
      throw new Error(`user ${user.id} is not an employee`)
    }

    removeEmployeeRole(user)
    return productsAPI.revokeCertificate({ user, application })
  }

  function createIntroductionFor ({ user, identity }) {
    const intro = {
      identity: buildResource.omitVirtual(identity)
    }

    if (user.profile) {
      intro.profile = user.profile
    }

    return buildResource({
      models: allModels,
      model: INTRODUCTION,
      resource: intro
    })
    .toJSON()
  }

  const mutuallyIntroduce = co(function* ({ req, a, b }) {
    const aPermalink = a.id || a
    const bPermalink = b.id || b
    const getUserA = typeof a === 'string' ? bot.users.get(a) : a
    const getUserB = typeof b === 'string' ? bot.users.get(b) : b
    const [aIdentity, bIdentity] = yield [
      bot.addressBook.byPermalink(aPermalink),
      bot.addressBook.byPermalink(bPermalink)
    ]

    const [userA, userB] = yield [getUserA, getUserB]
    const introduceA = createIntroductionFor({ user: a, identity: aIdentity })
    const introduceB = createIntroductionFor({ user: b, identity: bIdentity })
    yield [
      productsAPI.send({ req, to: userA, object: introduceB }),
      productsAPI.send({ req, to: userB, object: introduceA })
    ]
  })

  function removeEmployeeRole (user) {
    const idx = (user.roles || []).find(role => role.id === 'employee')
    if (idx !== -1) {
      user.roles.splice(idx, 1)
      return true
    }
  }

  function addEmployeeRole (user) {
    const employeeRole = buildResource.enumValue({
      model: privateModels.role,
      value: 'employee'
    })

    user.roles.push(employeeRole)
    return employeeRole
  }

  function isEmployee (user) {
    const { id } = buildResource.enumValue({
      model: privateModels.role,
      value: 'employee'
    })

    return user.roles && user.roles.some(role => role.id === id)
  }

  function willSend ({ req, other={} }) {
    const { message } = req
    const originalSender = message && message.originalSender
    if (originalSender) {
      debug('setting "forward" based on original sender')
      other.forward = originalSender
    }
  }

  // forward any messages sent by the bot
  // to the relationship manager
  const didSend = co(function* (input, sentObject) {
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
    yield forwardMessage({
      req,
      other,
      object: sentObject,
      to: relationshipManager
    })
  })

  const manager = {
    assignRelationshipManager,
    hire,
    fire,
    list: listEmployees,
    // get: getEmployee,
    hasEmployees,
    isEmployee
  }

  productsAPI.plugins.use({
    onFormsCollected,
    willSend,
    didSend
    // willSign: setEntityRole
  })

  // prepend
  productsAPI.plugins.use({
    onmessage,
  }, true)

  return manager
}
