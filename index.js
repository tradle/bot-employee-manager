const co = require('co').wrap
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
const ASSIGN_RM = 'tradle.AssignRelationshipManager'
const APPROVED = 'tradle.ApplicationApproval'
const DENIAL = 'tradle.ApplicationDenial'
const INTRODUCTION = 'tradle.Introduction'
const RESOLVED = Promise.resolve()
// const createAssignRMModel = require('./assign-rm-model')

exports = module.exports = function createEmployeeManager ({ productsAPI }) {
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
  function maybeForward ({ user, message, to }) {
    if (!isEmployee(user)) {
      debug(`refusing to forward message as sender "${user.id}" is not an employee`)
      return
    }

    const type = message.object[TYPE]
    debug(`forwarding ${type} from relationship manager ${user.id}`)
    return forwardMessage({ message, to })
  }

  const maybeAssignRM = co(function* ({ user, application, assignment }) {
    if (!isEmployee(user)) {
      debug(`refusing to assign relationship manager as sender "${user.id}" is not an employee`)
      return
    }

    const relationshipManager = parseStub(assignment.employee).permalink
    const applicationResource = yield productsAPI.getApplicationByStub(assignment.application)
    debug(`assigning relationship manager ${relationshipManager} to user ${user.id}`)
    yield assignRelationshipManager({
      user: parseStub(applicationResource.applicant).permalink,
      relationshipManager: relationshipManager === user.id ? user : relationshipManager,
      application: applicationResource
    })
  })

  const approveOrDeny = co(function* ({ user, application, judgment }) {
    // TODO: maybe only relationship manager or someone with the right role
    // should be able to perform these actions
    const approve = judgment[TYPE] === APPROVED

    let willSave
    if (!application) {
      application = yield productsAPI.getApplicationByStub(judgment.application)
      willSave = true
    }

    const applicantPermalink = parseStub(application.applicant).permalink
    if (applicantPermalink === user.id) {
      debug('applicant cannot approve/deny their own application')
      return
    }

    const applicant = yield bot.users.get(applicantPermalink)
    if (approve) {
      yield productsAPI.approveApplication({ user: applicant, application })
    } else {
      yield productsAPI.denyApplication({ user: applicant, application })
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

  const onmessage = co(function* ({ user, application, message }) {
    const { object, forward } = message
    const type = object[TYPE]
    // forward from employee to customer
    if (forward) {
      yield maybeForward({ user, message, to: forward })
      // prevent default processing
      return false
    }

    // assign relationship manager
    if (type === ASSIGN_RM) {
      yield maybeAssignRM({ user, application, assignment: object })
      return
    }

    if (type === APPROVED || type === DENIAL) {
      yield approveOrDeny({
        user,
        application,
        judgment: object
      })

      return
    }

    if (!application) return

    // forward from employee to customer
    const { relationshipManager } = application
    if (relationshipManager) {
      const rmPermalink = parseStub(relationshipManager).permalink
      debug(`forwarding ${type} to relationship manager ${rmPermalink}`)
      yield forwardMessage({
        message,
        to: rmPermalink
      })
    }
  })

  function forwardMessage ({ message, to }) {
    // const other = getCustomMessageProperties(message)
    // delete other.forward
    return productsAPI.send({ user: to, object: message })
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

  const assignRelationshipManager = co(function* ({ user, relationshipManager, application }) {
    const rmID = relationshipManager.id || relationshipManager
    if (application.relationshipManager === rmID) {
      return
    }

    [user, relationshipManager] = yield [user, relationshipManager].map(userOrId => {
      return typeof userOrId === 'string'
        ? bot.users.get(userOrId)
        : Promise.resolve(userOrId)
    })

    application.relationshipManager = relationshipManager.identity
    const promiseIntro = mutuallyIntroduce({ a: user, b: relationshipManager })
    const promiseSaveApplication = productsAPI.saveNewVersionOfApplication({
      user,
      application
    })

    yield [
      promiseIntro,
      promiseSaveApplication
    ]
  })

  // auto-approve first employee
  const onFormsCollected = co(function* (data) {
    const { user, application } = data
    if (isEmployee(user) || application.requestFor !== EMPLOYEE_ONBOARDING) {
      return
    }

    const hasAtLeastOneEmployee = yield hasEmployees()
    if (!hasAtLeastOneEmployee) {
      return hire({ user, application })
    }
  })

  // function setEntityRole (object) {
  //   if (object[TYPE] === EMPLOYEE_PASS) {
  //     object.entityRole = 'unspecified'
  //   }
  // }

  // const defaultOnFormsCollected = productsAPI.removeDefaultHandler('onFormsCollected')
  productsAPI.plugins.use({
    onFormsCollected,
    // willSign: setEntityRole
  })

  function hire ({ user, application }) {
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
    return productsAPI.approveApplication({ user, application })
  }

  function fire ({ user, application }) {
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

  const mutuallyIntroduce = co(function* ({ a, b }) {
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
      productsAPI.send({ user: userA, object: introduceB }),
      productsAPI.send({ user: userB, object: introduceA })
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

  const manager = {
    assignRelationshipManager,
    hire,
    fire,
    list: listEmployees,
    // get: getEmployee,
    hasEmployees,
    isEmployee
  }

  // prepend
  productsAPI.plugins.use({ onmessage }, true)
  return manager
}
