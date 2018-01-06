const bindAll = require('bindall')
const _ = require('lodash')
const { omitVirtual } = require('@tradle/build-resource')
const debug = require('debug')(require('./package').name)
const { TYPE, SIG, NONCE, SEQ, PREV_TO_RECIPIENT } = require('@tradle/constants')
const { models } = require('@tradle/models')
const ObjectModel = models['tradle.Object']
// const MessageModel = models['tradle.Message']
// const BUILT_IN_MESSAGE_PROPS = Object.keys(MessageModel.properties)
//   .concat(Object.keys(ObjectModel.properties))

const BUILT_IN_MESSAGE_PROPS = [
  [SEQ],
  [PREV_TO_RECIPIENT],
  [NONCE],
  'time',
  'object',
  'recipientPubKey'
].concat(Object.keys(ObjectModel.properties))

module.exports = {
  bindAll,
  debug,
  getCustomMessageProperties,
  uniqueStrings
}

function getCustomMessageProperties (message) {
  return _.omit(omitVirtual(message), BUILT_IN_MESSAGE_PROPS)
}

function uniqueStrings (arr) {
  const map = {}
  for (const str of arr) {
    map[str] = true
  }

  return Object.keys(map)
}
