
const Promise = require('bluebird')
const co = Promise.coroutine
const debug = require('debug')('tradle:bot:employee-manager')
const TYPE = '_t'
const STORAGE_KEY = require('./package').name

exports = module.exports = createEmployeeManager
// allow override
exports.storageKey = STORAGE_KEY

function createEmployeeManager (bot) {
  // employee onboarding
  // assign relationship manager to customers
  // forward messages between customer and relationship manager

  const { storageKey } = exports
  const { users, shared } = bot
  users.on('create', onNewUser)

  const receive = co(function* (data) {
    const { user, object, message } = data
    const { forward } = message
    if (forward) {
      const employees = yield getEmployees()
      if (!employees[user.id]) {
        debug(`refusing to forward message as sender "${user.id}" is not an employee`)
        return
      }

      return forwardTo({ object, message, userId: forward })
    }

    let employee = getRelationshipManager(user)
    if (!employee) {
      employee = yield chooseRelationshipManager(user)
    }

    if (employee) {
      // yielding slows things down...but ensure it gets forwarded
      yield forwardTo({ object, message, userId: employee })
    }
  })

  const presend = co(function* ({ user, object }) {
    if (object[TYPE] !== 'tradle.MyEmployeeOnboarding') return

    const employees = yield getEmployees()
    if (object.revoked) {
      delete employees[user.id]
    } else {
      employees[user.id] = {}
    }

    yield setEmployees(employees)
  })

  function forwardTo ({ userId, object, message }) {
    // pretty hacky to hardcode context here
    const { context } = message
    const other = context ? { context } : null
    return bot.send({
      userId,
      object,
      other
    })
  }

  const chooseRelationshipManager = co(function* (user) {
    const employees = yield getEmployees()
    const hat = Object.keys(employees)
    if (!hat.length) return

    const relationshipManager = getRabbit(hat)
    return assignRelationshipManager({ user, relationshipManager })
  })

  function getRelationshipManager (user) {
    const storage = user[storageKey]
    return storage && storage.relationshipManager
  }

  function assignRelationshipManager ({ user, relationshipManager }) {
    if (!user[storageKey]) user[storageKey] = {}

    const storage = user[storageKey]
    storage.relationshipManager = relationshipManager
    return relationshipManager
  }

  const getEmployees = co(function* () {
    try {
      return yield shared.get(storageKey)
    } catch (err) {
      return {}
    }
  })

  function setEmployees (employees) {
    return shared.put(storageKey, employees)
  }

  function onNewUser (user) {
    if (getRelationshipManager(user)) return

    chooseRelationshipManager(user)
    return users.save(user)
  }

  const unsubs = [
    bot.addReceiveHandler(receive),
    bot.addPreSendHandler(presend),
    () => users.removeListener('create', onNewUser)
  ]

  function uninstall () {
    unsubs.forEach(unsub => unsub())
  }

  return {
    uninstall,
    assignRelationshipManager: function ({ user, relationshipManager }) {
      assignRelationshipManager({ user, relationshipManager })
      return users.save(user)
    },
    employees: getEmployees
  }
}

/**
 * choose a random element from an array
 */
function getRabbit (hat) {
  const idx = Math.floor(Math.random() * hat.length)
  return hat[idx]
}
