
const Promise = require('bluebird')
const co = Promise.coroutine
const test = require('tape')
const rawCreateBot = require('@tradle/bots').bot
const manageMonkeys = require('./')
const TYPE = '_t'
const memdb = require('memdb')

function createBot (opts) {
  opts.inMemory = true
  return rawCreateBot(opts)
}

test('basic', co(function* (t) {
  const bot = createBot({
    send: co(function* ({ userId, object, other }) {
      const expected = expectedSends.shift()
      t.equal(userId, expected.to)
      t.equal(object[TYPE], expected.type)
    })
  })

  const db = memdb({ valueEncoding: 'json' })
  const employees = bot.use(manageMonkeys({ db }))

  const relationshipManager = 'bill'
  const customer = 'ted'
  const expectedSends = [
    {
      to: relationshipManager,
      type: 'tradle.MyEmployeeOnboarding'
    },
    {
      to: relationshipManager,
      type: 'tradle.Introduction'
    },
    {
      to: customer,
      type: 'tradle.FormRequest'
    }
  ]

  bot.on('error', t.error)
  yield bot.send({
    userId: relationshipManager,
    object: {
      [TYPE]: 'tradle.MyEmployeeOnboarding'
    }
  })

  t.same(yield employees.list(), { [relationshipManager]: {} })

  bot.receive({
    author: customer,
    objectinfo: {},
    object: {
      object: {
        [TYPE]: 'tradle.SelfIntroduction',
        identity: {}
      }
    }
  })

  yield receive()
  const ted = yield bot.users.get(customer)
  t.same(ted[manageMonkeys.storageKey], { relationshipManager })

  bot.receive({
    author: relationshipManager,
    objectinfo: {},
    object: {
      forward: customer,
      object: {
        [TYPE]: 'tradle.FormRequest'
      }
    }
  })

  yield receive()
  t.end()

  function receive () {
    return new Promise(resolve => bot.once('message', resolve))
  }
}))
