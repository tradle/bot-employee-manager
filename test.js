global.Promise = require('bluebird')

const crypto = require('crypto')
const { EventEmitter } = require('events')
const co = require('co').wrap
const test = require('tape')
const sinon = require('sinon')
const _ = require('lodash')
const createProductsStrategy = require('@tradle/bot-products')
const { TYPE, SIG } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const fakeResource = require('@tradle/build-resource/fake')
const baseModels = require('@tradle/merge-models')()
  .add(require('@tradle/models').models)
  .add(require('@tradle/custom-models'))
  .add(require('@tradle/models-products-bot'))
  .get()

const manageMonkeys = require('./')
const roleModel = baseModels['tradle.products.Role']
const employeeRole = buildResource.enumValue({
  model: roleModel,
  value: 'employee'
})

// function createBot (opts) {
//   opts.inMemory = true
//   return rawCreateBot(opts)
// }

test('basic', co(function* (t) {
  const relationshipManager = {
    id: 'bill',
    identity: {
      id: 'tradle.Identity_bill_123'
    },
    roles: [employeeRole]
  }

  const customerIdentityStub = {
    id: 'tradle.Identity_ted_123'
  }

  const application = {
    applicant: customerIdentityStub,
    context: newLink(),
    requestFor: 'tradle.CurrentAccount'
  }

  const customer = {
    id: 'ted',
    identity: customerIdentityStub,
    applications: [
      application
    ]
  }

  const applicationId = buildResource.id({
    model: baseModels['tradle.Application'],
    link: 'someApplicationLink',
    permalink: 'someApplicationLink'
  })

  let onmessage
  const { api, manager, bot, receive } = newMock({
    users: [
      customer,
      relationshipManager
    ],
    application
  })

  const { send } = api
  let sendSpy = sinon.spy(api, 'send')
  api.emit('bot', bot)

  yield receive({
    user: relationshipManager,
    // application,
    message: {
      context: application.context,
      object: {
        [TYPE]: 'tradle.AssignRelationshipManager',
        [SIG]: newSig(),
        employee: relationshipManager.identity,
        application: {
          id: applicationId
        }
      }
    },
    sendQueue: []
  })

  t.equal(sendSpy.callCount, 0)
  manager.handleMessages()

  yield receive({
    user: relationshipManager,
    // application,
    message: {
      context: application.context,
      object: {
        [TYPE]: 'tradle.AssignRelationshipManager',
        [SIG]: newSig(),
        employee: relationshipManager.identity,
        application: {
          id: applicationId
        }
      }
    },
    sendQueue: []
  })

  // console.log(sendSpy.getCalls().map(call => JSON.stringify(call.args[0].object)))
  t.equal(sendSpy.callCount, 3)
  t.equal(sendSpy.getCall(0).args[0].object[TYPE], 'tradle.Verification')
  t.equal(sendSpy.getCall(1).args[0].object[TYPE], 'tradle.Introduction')
  t.equal(sendSpy.getCall(2).args[0].object[TYPE], 'tradle.Introduction')
  t.equal(api.saveNewVersionOfApplication.callCount, 1)

  sendSpy.restore()
  sendSpy = sinon.spy(api, 'send')
  const reSignSpy = sinon.spy(bot, 'reSign')

  // forward to relationship manager
  yield receive({
    user: customer,
    application,
    message: {
      context: application.context,
      object: {
        [TYPE]: 'tradle.SimpleMessage',
        [SIG]: newSig(),
        message: 'hey'
      }
    }
  })

  const fwdHey = sendSpy.getCall(0).args[0]
  t.equal(fwdHey.object.message, 'hey')
  t.equal(fwdHey.to, relationshipManager.id)
  t.equal(fwdHey.other.originalSender, customer.id)
  t.equal(fwdHey.other.context, application.context)
  t.equal(reSignSpy.callCount, 0)

  sendSpy.restore()
  sendSpy = sinon.spy(api, 'send')

  // forward from relationship manager
  yield receive({
    user: relationshipManager,
    // no application specified
    message: {
      forward: customer.id,
      object: {
        [TYPE]: 'tradle.SimpleMessage',
        [SIG]: newSig(),
        message: 'ho'
      }
    }
  })

  const fwdHo = sendSpy.getCall(0).args[0]
  t.equal(fwdHo.object.message, 'ho')
  t.equal(fwdHo.to, customer.id)
  t.equal(fwdHo.other.originalSender, relationshipManager.id)
  t.equal(reSignSpy.callCount, 1)

  sendSpy.restore()
  sendSpy = sinon.spy(api, 'send')

  // forward from relationship manager
  // don't re-sign if original is authored by bot
  const botIdentity = yield bot.getMyIdentity()
  yield receive({
    user: relationshipManager,
    // no application specified
    message: {
      forward: customer.id,
      object: {
        [TYPE]: 'tradle.SimpleMessage',
        [SIG]: newSig(),
        message: 'hey ho',
        _author: botIdentity._permalink
      }
    }
  })

  const fwdHeyHo = sendSpy.getCall(0).args[0]
  t.equal(fwdHeyHo.object.message, 'hey ho')
  t.equal(fwdHeyHo.to, customer.id)
  t.equal(fwdHeyHo.other.originalSender, relationshipManager.id)
  t.equal(reSignSpy.callCount, 1)

  sendSpy.restore()
  sendSpy = sinon.spy(api, 'send')
  manager.handleMessages(false)

  yield receive({
    user: relationshipManager,
    // application,
    message: {
      context: application.context,
      object: {
        [TYPE]: 'tradle.AssignRelationshipManager',
        [SIG]: newSig(),
        employee: relationshipManager.identity,
        application: {
          id: applicationId
        }
      }
    },
    sendQueue: []
  })

  t.equal(sendSpy.callCount, 0)
  t.end()

  // bot.send({
  //   userId: relationshipManager,
  //   object: {
  //     [TYPE]: 'tradle.MyEmployeeOnboarding'
  //   }
  // })

  // t.same(yield employees.list(), { [relationshipManager]: {} })

  // bot.receive(fakeWrapper({
  //   from : customer,
  //   object: {
  //     [TYPE]: 'tradle.SelfIntroduction',
  //     identity: {}
  //   }
  // })

  // yield receive()
  // const ted = yield bot.users.get(customer)
  // t.same(ted[manageMonkeys.storageKey], { relationshipManager })

  // const fromRM = fakeWrapper({
  //   from: relationshipManager,
  //   object: {
  //     [TYPE]: 'tradle.FormRequest'
  //   }
  // })

  // fromRM.message.forward = customer
  // bot.receive(fromRM)

  // yield receive()
  // t.end()

  // function receive () {
  //   return new Promise(resolve => bot.once('message', resolve))
  // }
}))

function fakeBot ({ users }) {
  const handlers = []
  const identities = _.transform(users, (result, user) => {
    result[user.id] = fakeResource({
      models: baseModels,
      model: baseModels['tradle.Identity'],
      signed: true
    })
  }, {})

  const bot = {
    db: {
      find: () => Promise.resolve({ items: [] }),
      findOne: () => Promise.resolve({}),
      put: obj => Promise.resolve(),
      del: obj => Promise.resolve()
    },
    sign: object => {
      object = _.clone(object)
      object[SIG] = crypto.randomBytes(128).toString('hex')
      return Promise.resolve(object)
    },
    reSign: object => {
      return bot.sign(object)
    },
    seal: sinon.stub().callsFake(function ({ link }) {
      if (typeof link !== 'string') {
        return Promise.reject(new Error('expected string link'))
      }

      return Promise.resolve()
    }),
    getMyIdentity: () => Promise.resolve({ _permalink: 'zzz' }),
    addressBook: {
      byPermalink: co(function* (permalink) {
        const identity = identities[permalink]
        if (identity) return identity
        throw new Error('identity not found')
      })
    },
    users: {
      get: co(function* (permalink) {
        const user = users.find(user => user.id === permalink)
        if (!user) {
          throw new Error('user not found')
        }

        return user
      }),
      save: co(function* (user) {
        users[user.id] = user
      }),
      merge: co(function* (user) {
        _.extend(users[user.id], user)
      })
    },
    presignEmbeddedMediaLinks: object => Promise.resolve(object),
    onmessage: handler => handlers.push(handler),
    send: co(function* () {
    }),
    messsages: {
      inbox: {
        find: () => {
          return Promise.resolve([])
        }
      }
    }
  }

  const receive = req => {
    if (req.application) {
      req.context = req.application.context
    }

    normalizeReq(req)
    return series(handlers, handler => handler(req))
  }

  return {
    bot,
    receive
  }
}

function newMock ({ users, application }) {
  const { bot, receive } = fakeBot({ users })
  const productsAPI = createProductsStrategy({
    namespace: 'test',
    models: {
      all: baseModels,
      private: {
        role: {
          id: roleModel.id,
          enum: [
            { id: 'employee' }
          ]
        }
      }
    },
    products: []
  })

  if (application) {
    sinon.stub(productsAPI, 'getApplicationByStub').resolves(application)
    sinon.stub(productsAPI.state, 'getApplicationsByType').returns(application)
    sinon.stub(productsAPI, 'saveNewVersionOfApplication').resolves({})
  }

  // const api = extend(new EventEmitter(), {
  //   bot,
  //   saveNewVersionOfApplication: sinon.stub().resolves({}),
  //   getApplicationByStub: sinon.stub().resolves(application),
  //   state: {
  //     getApplicationsByType: sinon.stub().returns(application),
  //   },
  //   models: {
  //     all: baseModels,
  //     private: {
  //       role: {
  //         id: 'Role',
  //         enum: [
  //           { id: 'employee' }
  //         ]
  //       }
  //     }
  //   },
  //   plugins: {
  //     use: function (plugin) {
  //       onmessage = plugin.onmessage
  //     }
  //   },
  //   addProducts: function () {

  //   },
  //   send: co(function* ({ req, object, to, other }) {
  //     // const expected = expectedSends.shift()
  //     // t.equal(userId, expected.to)
  //     // t.equal(object[TYPE], expected.type)
  //   })
  // })

  productsAPI.install(bot)
  const manager = manageMonkeys({ bot, productsAPI, handleMessages: false })
  return {
    bot,
    receive,
    api: productsAPI,
    manager
  }
}

const series = co(function* (arr, fn) {
  for (const arg of arr) {
    const ret = fn(arg)
    if (isPromise(ret)) yield ret
  }
})

function normalizeReq (req) {
  const { user, message } = req
  if (!req.object) req.object = message.object
  if (!req.type) req.type = req.object[TYPE]
  if (!req.link) req.link = newLink()
  if (!req.permalink) req.permalink = newLink()
  // if (!req.forward) req.forward = message.forward
  return req
}

function isPromise (obj) {
  return obj && typeof obj.then === 'function'
}

function newSig () {
  return crypto.randomBytes(128).toString('base64')
}

function newLink () {
  return crypto.randomBytes(32).toString('hex')
}
