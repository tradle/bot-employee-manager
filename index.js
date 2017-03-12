
const Promise = require('bluebird')
const co = Promise.coroutine
const debug = require('debug')('tradle:bot:employee-manager')
const collect = Promise.promisify(require('stream-collector'))
const TYPE = '_t'
const STORAGE_KEY = require('./package').name

exports = module.exports = createEmployeeManager
// allow override
exports.storageKey = STORAGE_KEY

function createEmployeeManager ({ db }) {
  db = Promise.promisifyAll(db)
  return bot => install(bot, db)
}

function install (bot, db) {
  // employee onboarding
  // assign relationship manager to customers
  // forward messages between customer and relationship manager
  const { storageKey } = exports
  const { users, shared } = bot
  // users.on('create', onNewUser)

  const receive = co(function* (data) {
    const { user, object, message } = data
    const { forward } = message
    if (forward) {
      const employees = yield listEmployees()
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

  const getEmployee = co(function* ({ userId }) {
    const employees = yield listEmployees()
    return employees[userId]
  })

  const presend = co(function* ({ user, object }) {
    if (object[TYPE] !== 'tradle.MyEmployeeOnboarding') return

    if (object.revoked) {
      debug(`revoking employee pass for: ${user.id}`)
      yield db.delAsync(user.id)
    } else {
      debug(`saving employee: ${user.id}`)
      yield db.putAsync(user.id, {})
    }
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

    const employees = yield listEmployees()
    const hat = Object.keys(employees)
    if (!hat.length) return

    const relationshipManager = getRabbit(hat)
    assignRelationshipManager({ user, relationshipManager })

    const identity = getIdentity({ user })
    if (!identity) {
      debug(`can't introduce "${user.id}" to relationship manager, don't have their identity`)
      return
    }

    // const profile = getProfile({ user })
    const introduction = {
      [TYPE]: 'tradle.Introduction',
      identity
    }

    // if (profile) {
    //   introduction.profile = profile
    // }

    return bot.send({
      userId: relationshipManager,
      object: introduction
    })
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

  const listEmployees = co(function* () {
    const employees = yield collect(db.createReadStream())
    const userIdToProps = {}
    employees.forEach(({ key, value }) => {
      userIdToProps[key] = value
    })

    return userIdToProps
  })

  // function onNewUser (user) {
  //   if (getRelationshipManager(user)) return

  //   chooseRelationshipManager(user)
  //   return users.save(user)
  // }

  const unsubs = [
    bot.addReceiveHandler(receive),
    bot.addPreSendHandler(presend),
    // () => users.removeListener('create', onNewUser)
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
    list: listEmployees,
    get: getEmployee
  }
}

/**
 * choose a random element from an array
 */
function getRabbit (hat) {
  const idx = Math.floor(Math.random() * hat.length)
  return hat[idx]
}

function getIdentity ({ user }) {
  const msg = user.history.find(wrapper => {
    if (!wrapper.inbound) return
    if (wrapper.author !== user.id) return

    const type = wrapper.object.object[TYPE]
    return type === 'tradle.SelfIntroduction' || type === 'tradle.IdentityPublishRequest'
  })

  return msg && msg.object.object.identity
}
