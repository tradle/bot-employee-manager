const bindAll = require('bindall')
// const _ = require('lodash')
const buildResource = require('@tradle/build-resource')
const { omitVirtual } = buildResource
const { parseStub } = require('@tradle/validate-resource').utils
const debug = require('debug')(require('./package').name)
const { TYPE, SIG, NONCE, SEQ, PREV_TO_RECIPIENT } = require('@tradle/constants')
const {
  VERIFICATION,
  INTRODUCTION,
  OBJECT
} = require('./types')

const models = require('./models')
const ObjectModel = models[OBJECT]
// const MessageModel = models['tradle.Message']
// const BUILT_IN_MESSAGE_PROPS = Object.keys(MessageModel.properties)
//   .concat(Object.keys(ObjectModel.properties))

// const BUILT_IN_MESSAGE_PROPS = [
//   [SEQ],
//   [PREV_TO_RECIPIENT],
//   [NONCE],
//   'time',
//   'object',
//   'recipientPubKey'
// ].concat(Object.keys(ObjectModel.properties))

// const getCustomMessageProperties = message => {
//   return _.omit(omitVirtual(message), BUILT_IN_MESSAGE_PROPS)
// }

const uniqueStrings = arr => {
  const map = {}
  for (const str of arr) {
    map[str] = true
  }

  return Object.keys(map)
}

const getUserIdentityStub = user => user.identity || { id: user.id }

const getPermalinkFromStub = stub => parseStub(stub).permalink

const createVerificationForDocument = document => {
  return buildResource({
      models,
      model: VERIFICATION
    })
    .set({
      document,
      dateVerified: Date.now()
    })
    .toJSON()
}

const createIntroductionToUser = ({ user, identity }) => {
  const intro = {
    identity: omitVirtual(identity)
  }

  if (user.profile) {
    intro.profile = user.profile
  }

  return buildResource({
    models,
    model: INTRODUCTION,
    resource: intro
  })
  .toJSON()
}

const defaultLogger = {
  debug,
  log: debug,
  error: debug,
  warn: debug,
  info: debug
}

const removeEmployeeRole = user => {
  const idx = (user.roles || []).find(role => role.id === 'employee')
  if (idx !== -1) {
    user.roles.splice(idx, 1)
    return true
  }
}

module.exports = {
  bindAll,
  debug,
  // getCustomMessageProperties,
  uniqueStrings,
  getUserIdentityStub,
  getPermalinkFromStub,
  createIntroductionToUser,
  createVerificationForDocument,
  defaultLogger,
  removeEmployeeRole
}
