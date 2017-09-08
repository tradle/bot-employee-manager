const { EventEmitter } = require('events')
const co = require('co').wrap
const test = require('tape')
const sinon = require('sinon')
const extend = require('xtend/mutable')
const { TYPE } = require('@tradle/constants')
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
  const user = {
    id: 'bill',
    roles: [{ id: 'RoleModel_employee' }]
  }

  const relationshipManager = { id: 'ted' }
  const application = {
    applicant: {
      id: buildResource.id({
        model: baseModels['tradle.Identity'],
        link: user.id,
        permalink: user.id
      })
    }
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
      users: {
        get: co(function* (link) {
          if (link === user.id) {
            return user
          }

          if (link === relationshipManager.id) {
            return relationshipManager
          }

          throw new Error('user not found')
        }),
        merge: sinon.stub()
      },
    },
    getApplicationByStub: sinon.stub().returns(Promise.resolve(application)),
    state: {
      getApplicationsByType: sinon.stub().returns(application),
    },
    models: {
      all: baseModels,
      private: {
        role: {
          id: 'RoleModel',
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
    send: co(function* ({ userId, object, other }) {
      // const expected = expectedSends.shift()
      // t.equal(userId, expected.to)
      // t.equal(object[TYPE], expected.type)
    })
  })

  const sendSpy = sinon.spy(productsAPI, 'send')
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
    user,
    application,
    message: {
      object: {
        [TYPE]: 'tradle.AssignRelationshipManager',
        employee: {
          id: buildResource.id({
            model: baseModels['tradle.Identity'],
            link: relationshipManager.id,
            permalink: relationshipManager.id
          })
        },
        application: {
          id: applicationId
        }
      }
    }
  })

  console.log(sendSpy.getCall(0))

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
