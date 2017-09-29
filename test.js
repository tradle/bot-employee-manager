const { EventEmitter } = require('events')
const co = require('co').wrap
const test = require('tape')
const sinon = require('sinon')
const extend = require('xtend/mutable')
const { TYPE, SIG } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const baseModels = require('@tradle/merge-models')()
  .add(require('@tradle/models').models)
  .add(require('@tradle/custom-models'))
  .get()

const manageMonkeys = require('./')

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
    roles: [{ id: 'Role_employee' }]
  }

  const customer = {
    id: 'ted',
    identity: {
      id: 'tradle.Identity_ted_123'
    }
  }

  const application = {
    applicant: customer.identity
  }

  const applicationId = buildResource.id({
    model: baseModels['tradle.Application'],
    link: 'someApplicationLink',
    permalink: 'someApplicationLink'
  })

  let onmessage
  const productsAPI = extend(new EventEmitter(), {
    bot: {
      db: {},
      reSign: sinon.stub().callsFake(object => {
        object[SIG] += '1'
        return Promise.resolve(object)
      }),
      getMyIdentity: sinon.stub().resolves({ _permalink: 'zzz' }),
      addressBook: {
        byPermalink: permalink => {
          if (permalink !== customer.id && permalink !== relationshipManager.id) {
            throw new Error('expected customer or relationshipManager')
          }

          return {}
        }
      },
      users: {
        get: co(function* (link) {
          if (link === customer.id) {
            return customer
          }

          if (link === relationshipManager.id) {
            return relationshipManager
          }

          throw new Error('user not found')
        }),
        merge: sinon.stub()
      },
    },
    saveNewVersionOfApplication: sinon.stub().resolves({}),
    getApplicationByStub: sinon.stub().resolves(application),
    state: {
      getApplicationsByType: sinon.stub().returns(application),
    },
    models: {
      all: baseModels,
      private: {
        role: {
          id: 'Role',
          enum: [
            { id: 'employee' }
          ]
        }
      }
    },
    plugins: {
      use: function (plugin) {
        onmessage = plugin.onmessage
      }
    },
    addProducts: function () {

    },
    send: co(function* ({ req, object, to, other }) {
      // const expected = expectedSends.shift()
      // t.equal(userId, expected.to)
      // t.equal(object[TYPE], expected.type)
    })
  })

  let sendSpy = sinon.spy(productsAPI, 'send')
  const manager = manageMonkeys({ productsAPI })
  productsAPI.emit('bot', productsAPI.bot)

  // const expectedSends = [
  //   {
  //     to: relationshipManager,
  //     type: 'tradle.MyEmployeeOnboarding'
  //   },
  //   {
  //     to: relationshipManager,
  //     type: 'tradle.Introduction'
  //   },
  //   {
  //     to: customer,
  //     type: 'tradle.FormRequest'
  //   }
  // ]

  productsAPI.bot.db.find = sinon.stub().returns(Promise.resolve({ items: [] }))
  yield onmessage({
    user: relationshipManager,
    application,
    message: {
      object: {
        [TYPE]: 'tradle.AssignRelationshipManager',
        employee: relationshipManager.identity,
        application: {
          id: applicationId
        }
      }
    },
    sendQueue: []
  })

  t.equal(sendSpy.getCall(0).args[0].object[TYPE], 'tradle.Introduction')
  t.equal(sendSpy.getCall(1).args[0].object[TYPE], 'tradle.Introduction')
  t.equal(productsAPI.saveNewVersionOfApplication.callCount, 1)

  sendSpy.restore()
  sendSpy = sinon.spy(productsAPI, 'send')

  yield onmessage({
    user: customer,
    application,
    message: {
      object: {
        [TYPE]: 'tradle.SimpleMessage',
        message: 'hey'
      }
    }
  })

  // forward to relationship manager
  const fwdHey = sendSpy.getCall(0).args[0]
  t.equal(fwdHey.object.message, 'hey')
  t.equal(fwdHey.to, relationshipManager.id)
  t.equal(fwdHey.other.originalSender, customer.id)
  t.equal(productsAPI.bot.reSign.callCount, 0)

  sendSpy.restore()
  sendSpy = sinon.spy(productsAPI, 'send')

  yield onmessage({
    user: relationshipManager,
    // no application specified
    message: {
      forward: customer.id,
      object: {
        [TYPE]: 'tradle.SimpleMessage',
        message: 'ho'
      }
    }
  })

  // forward from relationship manager
  const fwdHo = sendSpy.getCall(0).args[0]
  t.equal(fwdHo.object.message, 'ho')
  t.equal(fwdHo.to, customer.id)
  t.equal(fwdHo.other.originalSender, relationshipManager.id)
  t.equal(productsAPI.bot.reSign.callCount, 1)

  sendSpy.restore()
  sendSpy = sinon.spy(productsAPI, 'send')

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
