const co = require('co').wrap
const pick = require('lodash/pick')
const clone = require('lodash/clone')
const extend = require('lodash/extend')
const allSettled = require('settle-promise').settle

const { TYPE, SIG } = require('@tradle/constants')
const buildResource = require('@tradle/build-resource')
const { buildResourceStub, title } = require('@tradle/build-resource')

const { parseStub } = require('@tradle/validate-resource').utils
const { isSubClassOf } = require('@tradle/validate-model').utils

const models = require('./models')
const {
  debug,
  // getCustomMessageProperties,
  bindAll,
  uniqueStrings,
  getUserIdentityStub,
  getPermalinkFromStub,
  createIntroductionToUser,
  createVerificationForDocument,
  removeEmployeeRole,
  defaultLogger
} = require('./utils')

const PACKAGE_NAME = require('./package').name
const {
  EMPLOYEE_ONBOARDING,
  EMPLOYEE_PASS,
  PUB_KEY,
  ASSIGN_RM,
  APPROVAL,
  DENIAL,
  IDENTITY,
  IDENTITY_PUBLISH_REQUEST,
  INTRODUCTION,
  SHARE_REQUEST,
  VERIFICATION,
  APPLICATION,
  APPLICATION_SUBMITTED,
  FORM_REQUEST,
  FORM_ERROR,
  PRODUCT_REQUEST,
  MESSAGE,
  SIMPLE_MESSAGE,
  REQUEST_ERROR,
  CHECK_OVERRIDE,
  CHECK,
  CUSTOMER_WAITING,
  SELF_INTRODUCTION,
  DEVICE_SYNC,
  DEVICE_SYNC_DATA_BUNDLE,
  CE_NOTIFICATION
} = require('./types')
const { MY_PRODUCT, CUSTOMER } = require('@tradle/bot-products/types')

const ACTION_TYPES = [ASSIGN_RM, VERIFICATION, APPROVAL, DENIAL]
const INTRO_TYPES = [CUSTOMER_WAITING, SELF_INTRODUCTION, INTRODUCTION, IDENTITY_PUBLISH_REQUEST]

const notNull = x => x != null
const roleModel = require('@tradle/models-products-bot')['tradle.products.Role']
const isActionType = type => ACTION_TYPES.includes(type)
const isIntroType = type => INTRO_TYPES.includes(type)
const RESOLVED = Promise.resolve()
// const createAssignRMModel = require('./assign-rm-model')
const alwaysTrue = () => true
const ORDER_BY_TIME_DESC = {
  property: '_time',
  desc: true
}

const DEVICE_SYNC_EXCLUDE = [...ACTION_TYPES, CHECK, CHECK_OVERRIDE, INTRODUCTION]

exports = module.exports = function createEmployeeManager (opts) {
  return new EmployeeManager(opts)
}

exports.isEmployee = isEmployee

function isEmployee ({ user, masterUser }) {
  let realUsers = [user, masterUser].filter(value => value)
  const { id } = buildResource.enumValue({
    model: roleModel,
    value: 'employee'
  })
  return realUsers.some(user => user.roles && user.roles.some(role => role.id === id))
}

function EmployeeManager ({
  bot,
  productsAPI,
  approveAll,
  wrapForEmployee,
  logger = defaultLogger,
  shouldForwardFromEmployee = alwaysTrue,
  shouldForwardToEmployee = alwaysTrue,
  handleMessages = true
}) {
  bindAll(this)

  // assign relationship manager to customers
  // forward messages between customer and relationship manager
  this.productsAPI = productsAPI
  this.logger = logger
  this._approveAll = approveAll
  this._wrapForEmployee = wrapForEmployee
  this._shouldForwardToEmployee = shouldForwardToEmployee
  this._shouldForwardFromEmployee = shouldForwardFromEmployee
  // const assignRMModel = createAssignRMModel({ productsAPI })
  this.bot = bot
  this._pluginSubscriptions = []
  this._handlingMessages = false
  if (handleMessages) this.handleMessages()
}

const proto = EmployeeManager.prototype

proto.handleMessages = function handleMessages (handle = true) {
  if (this._handlingMessages === handle) return

  this._handlingMessages = handle
  const { productsAPI } = this

  if (handle === false) {
    this._pluginSubscriptions.forEach(unsubscribe => unsubscribe())
    return
  }

  this._pluginSubscriptions = [
    productsAPI.plugins.use({
      onFormsCollected: this._onFormsCollected,
      willSend: this._willSend,
      onRequestForExistingProduct: this._onRequestForExistingProduct,
      didSend: this._didSend
      // willSign: setEntityRole
    }),

    // prepend
    productsAPI.plugins.use(
      {
        onmessage: this._onmessage,
        deduceApplication: this._deduceApplication
      },
      true
    ),

    productsAPI.plugins.use({
      didApproveApplication: ({ req, user, application }, certificate) => {
        if (certificate[TYPE] == EMPLOYEE_PASS) {
          this._addEmployeeRole(user)
        }
      }
    })
  ]
}

proto._deduceApplication = co(function*(req, forceAction) {
  const { message = {} } = req
  if (!this.isEmployee(req)  &&  !forceAction) return

  const { context, forward, object } = message
  const type = object[TYPE]
  if (
    type === ASSIGN_RM ||
    type == APPROVAL ||
    type === DENIAL ||
    type === CE_NOTIFICATION ||
    this.bot.models[type].subClassOf === CHECK_OVERRIDE
  ) {
    return yield this.productsAPI.getApplicationByStub(object.application)
  }

  const isAction = forceAction || isActionType(type)
  if (forward && !isAction) {
    // ignore
    return false
  }

  if (!(context && isAction)) return

  try {
    let { items } = yield this.bot.db.find({
      filter: {
        EQ: {
          [TYPE]: APPLICATION,
          context
        }
      },
      orderBy: ORDER_BY_TIME_DESC
    })
    let application
    if (!items.length)
      return
    application = yield this.bot.getResource(items[0], { backlinks: ['submissions', 'checks'] })
    this.productsAPI.state.organizeSubmissions(application)
    return application
  } catch (err) {
    this.logger.debug('failed to get application by context', {
      error: err.stack,
      context
    })
  }
})
/**
 * Attempt to detect the employee to forward the message to based on the "context"
 *
 */
proto._maybeForwardByContext = co(function*({ req }) {
  const { user, context } = req
  // don't forward employee to employee
  if (!context || this.isEmployee(req)) return

  const { bot } = this
  let last
  try {
    last = yield this._getLastInboundMessageByContext({ user, context })
  } catch (err) {
    this.logger.debug('failed to determine forward target by context', err.message)
    return
  }

  this.logger.debug(`found forward target candidate ${JSON.stringify(last)} by context ${context}`)
  const { _author } = last
  const candidate = yield bot.users.get(_author)
  if (!this.isEmployee({ user: candidate })) return

  const type = req.message.object[TYPE]
  this.logger.debug('forwarding', {
    to: 'guessed employee based on context',
    type,
    context,
    author: user.id,
    recipient: candidate.id
  })

  yield this.forwardToEmployee({
    req,
    from: req.user,
    to: candidate,
    other: { context }
  })
})

proto._getLastInboundMessageByContext = co(function*({ user, context }) {
  // if (models['tradle.Message'].isInterface) {
  // const results = yield this.bot.messages.inbox.find({
  //   IndexName: 'context',
  //   KeyConditionExpression: '#context = :context',
  //   FilterExpression: '#author <> :author',
  //   ExpressionAttributeNames: {
  //     '#context': 'context',
  //     '#author': '_author'
  //   },
  //   ExpressionAttributeValues: {
  //     ':context': context,
  //     ':author': user.id
  //   },
  //   ScanIndexForward: false,
  //   Limit: 10
  // })

  // if (!results.length) {
  //   throw new Error('NotFound')
  // }

  // return results[0]
  // }

  return yield this.bot.db.findOne({
    select: ['_author'],
    filter: {
      EQ: {
        [TYPE]: MESSAGE,
        context,
        _inbound: true
      },
      NEQ: {
        _author: user.id
      }
    },
    orderBy: ORDER_BY_TIME_DESC
  })
})

proto._maybeForwardToOrFromEmployee = co(function*({ req, forward }) {
  const { bot } = this
  const { user, message, masterUser } = req
  const { object } = message
  const type = object[TYPE]
  if (this.isEmployee(req)) {
    const myPermalink = yield this.bot.getPermalink()
    if (myPermalink === forward) {
      this.logger.debug(`not forwarding ${type} ${object._link} to self`)
      return
    }

    const shouldForward = yield Promise.resolve(this._shouldForwardFromEmployee({ req }))

    if (!shouldForward) {
      this.logger.debug(`not forwarding ${type} from employee ${user.id} to ${forward}`)
      return
    }

    this.logger.debug('forwarding', {
      to: 'customer (specified by employee in message.forward)',
      type,
      context: message.context,
      author: user.id,
      recipient: forward
    })
    // yield this.forward({ req, to: forward })

    // forward to all employee devices
    let employeeHashes = yield this._getPairedIdentitiesHashes(req)

    let hashes = [forward].concat(employeeHashes)

    // forward to all client devices
    let pairedIdentities = yield this.getOtherClientIdentities({ id: forward })
    hashes = hashes.concat(pairedIdentities)
    if (pairedIdentities.length)
      req.clientIdentities = pairedIdentities
      // yield Promise.all(pairedIdentities.map(hash => req.sendQueue.push({ req, to:hash, object, other })))
    yield Promise.all(hashes.map(hash => this.forward({ req, to: hash })))

    return
  }

  let recipient
  try {
    recipient = yield bot.users.get(forward)
  } catch (err) {
    this.logger.debug(`final recipient ${forward} specified in "forward" was not found`)
    return
  }

  if (!this.isEmployee({ user: recipient })) {
    this.logger.debug(
      `refusing to forward: neither sender "${user.id}" nor recipient "${forward}" is an employee`
    )
    return
  }

  const shouldForward = yield Promise.resolve(this._shouldForwardToEmployee({ req }))

  if (!shouldForward) {
    this.logger.debug(`not forwarding ${type} from ${user.id} to employee ${forward}`)
    return
  }

  this.logger.debug('forwarding', {
    to: 'employee (specified in message.forward)',
    type,
    context: message.context,
    author: user.id,
    recipient: forward
  })

  // don't unwrap-and-re-sign
  yield this.forwardToEmployee({
    req,
    from: req.user,
    to: forward
  })
  // yield this.forward({ req, to: forward })
})
proto.getOtherClientIdentities = co(function*({ id })  {
  let clientIdentity = yield this.bot.addressBook.byPermalink(id)
  let pairedIdentities = []
  clientIdentity.pubkeys.forEach(pub => {
    if (pub.importedFrom) pairedIdentities.push(pub.importedFrom)
  })
  if (pairedIdentities.length)  return pairedIdentities
  let pubKey
  try {
    pubKey = yield this.bot.db.findOne({
      filter: {
        EQ: {
          [TYPE]: PUB_KEY,
          importedFrom: id
        }
      }
    })
  } catch (err) {
    // debugger
  }
  if (!pubKey) return pairedIdentities
  clientIdentity = yield this.bot.addressBook.byPermalink(pubKey.permalink || pubKey.owner._permalink)
  clientIdentity.pubkeys.forEach(pub => {
    if (pub.importedFrom  &&  pub.importedFrom !== id) pairedIdentities.push(pub.importedFrom)
  })
  return [clientIdentity._permalink].concat(pairedIdentities)
})

proto.forward = co(function*({ req, to }) {
  const { user, message } = req
  const { object } = message
  const other = {
    originalSender: user.id
  }

  if (message.context) {
    other.context = message.context
  }

  return this.productsAPI.send({ req, object, to, other })
})

proto._maybeAssignRM = co(function*({ req, assignment }) {
  const { bot, productsAPI } = this
  let { user, application, applicant } = req
  // if (!this.isEmployee(user)) {
  if (!this.isEmployee(req)) {
    this.logger.debug(
      `refusing to assign relationship manager as sender "${user.id}" is not an employee`
    )
    return
  }

  // const relationshipManager = assignment._masterAuthor || getPermalinkFromStub(assignment.employee)
  const relationshipManager = getPermalinkFromStub(assignment.employee)
  if (!applicant && assignment.application) {
    application = yield bot.getResource(assignment.application)
    // if (!application)
    //   debugger
    ;({ applicant } = application)
      applicant ={ id: applicant._permalink }
      extend(req, { application, applicant })
  }
  if (relationshipManager === applicant.id) {
    this.logger.debug(
      'applicant attempted to become the relationship manager for own application',
      {
        application: application._permalink
      }
    )

    yield this.productsAPI.send({
      req,
      to: user,
      application,
      object: {
        [TYPE]: SIMPLE_MESSAGE,
        message: `You can't be the relationship manager for your own application!`
      }
    })

    return
  }

  yield this.assignRelationshipManager({
    req,
    applicant,
    assignment,
    relationshipManager: relationshipManager === user.id ? user : relationshipManager,
    application
  })
})

proto.approveOrDeny = co(function*({ req, judge, applicant, application, judgment }) {
  const { bot, productsAPI } = this
  // TODO: maybe only relationship manager or someone with the right role
  // should be able to perform these actions
  const approve = judgment[TYPE] === APPROVAL

  if (!application) {
    application = yield productsAPI.getApplicationByStub(judgment.application)
  }

  const applicantPermalink = parseStub(application.applicant).permalink
  if (applicantPermalink === judge.id) {
    this.logger.debug('applicant attempted to approve/deny their own application', {
      application: application._permalink
    })

    yield this.productsAPI.send({
      req,
      to: judge,
      application,
      object: {
        [TYPE]: SIMPLE_MESSAGE,
        message: `You can't approve/deny your own application!`
      }
    })

    return
  }

  if (!applicant) applicant = yield bot.users.get(applicantPermalink)

  const opts = { req, user: applicant, application, judge }
  const verb = approve ? 'approved' : 'denied'
  this.logger.debug(`relationship manager ${verb} application`, {
    relationshipManager: judge.id,
    application: application._permalink
  })

  try {
    if (approve) {
      yield productsAPI.approveApplication(opts)
    } else {
      yield productsAPI.denyApplication(opts)
    }
  } catch (err) {
    switch (err.name) {
      case 'Duplicate':
        yield this.productsAPI.send({
          req,
          to: judge,
          application,
          object: {
            [TYPE]: SIMPLE_MESSAGE,
            message: `This application has already been ${verb}`
          }
        })
        break
      case 'AbortError':
        yield this.productsAPI.send({
          req,
          to: judge,
          application,
          object: {
            [TYPE]: REQUEST_ERROR,
            message: err.message,
            application,
            date: new Date().getTime()
          }
        })
        break
      default:
        throw err
    }
  }
})

proto._onmessage = co(function*(req) {
  let { user, masterUser, allUsers, application, applicant, message } = req
  this.logger.debug(
    'processing message, custom props:',
    pick(message, ['originalSender', 'forward'])
  )

  const { object, forward } = message
  const type = object[TYPE]
  // forward from employee to customer

  let isEmployee = this.isEmployee(req)
  if (isEmployee) {
    let { done, stop } = yield this._checkForEmployee(req)
    if (done) return
    if (stop) return false
  }
  else if (!isIntroType(type)) {
    let pairedIdentities = yield this._getPairedIdentitiesHashes(req)
    if (pairedIdentities.length) {
      if (type === DEVICE_SYNC) {
        if (!masterUser) return
        // debugger
        let bundle = yield this._getSyncBundle({ masterUser, user, allUsers })
        let { items } = bundle.items
        this.logger.debug(`Sending ${DEVICE_SYNC_DATA_BUNDLE} to ${user.id}: ${items.map(item => item[TYPE])}`)
        yield this.bot.send({ to: user.id, object: bundle })
        return
      }
      if (!application) {
        application = yield this._deduceApplication(req, true)
        if (application)
          req.application = application
      }

      yield Promise.all(pairedIdentities.map((to, i) => {
        this.forward({ req, to })
      }))
    }
  }

  if (forward) {
    yield this._maybeForwardToOrFromEmployee({ req, forward })
    // prevent default processing
    this.logger.debug('preventing further processing of inbound message')
    return false
  }

  if (!application) {
    yield this._maybeForwardByContext({ req })
    return
  }

  // forward from customer to relationship manager
  // const { relationshipManagers } = application
  // if (!relationshipManagers) return

  const { analyst } = application
  if (!analyst) return

  const employeePass = yield this.bot.getResource(analyst)
  const employee = employeePass.owner


  // yield relationshipManagers.map(co(function* (stub) {
  yield [employee].map(
    co(function*(stub) {
      const rmPermalink = getPermalinkFromStub(stub)
      this.logger.debug('forwarding', {
        to: 'rm',
        type,
        context: message.context,
        author: user.id,
        recipient: rmPermalink
      })

      yield this.forwardToEmployee({
        req,
        from: req.user,
        to: rmPermalink
      })
    }).bind(this)
  )
})
proto._checkForEmployee = co(function* (req) {
  let { user, masterUser, application, applicant, message } = req
  const { object } = message
  const type = object[TYPE]
  const { models } = this.bot
  if (application) {
    if (type === APPROVAL || type === DENIAL) {
      yield this.approveOrDeny({
        req,
        judge: user,
        applicant,
        application,
        judgment: object
      })

      return { done: true }
    }

    if (type === VERIFICATION  ||  isSubClassOf({ subModel: models[CHECK_OVERRIDE], model: models[type], models })) {
      // defer to bot-products to import
      return { done: true }
    }
  }
  // assign relationship manager
  if (type === ASSIGN_RM) {
    yield this._maybeAssignRM({ req, assignment: object })
    return { done: true }
  }

  if (type === SHARE_REQUEST) {
    yield this._onShareRequest({ req })
    return { done: true }
  }
  // Employee communicates with the client only inside some client application
  if (!application) {
    application = yield this._deduceApplication(req, true)
    if (!application) return {} // { done: true }
    req.application = application
  }
  if (!application.analyst) {
    if (application.draft)
      return { done: true }
    // Case when employee fills out the application for the client and never sends it to him
    else if (application.applicant._permalink === user.identity._permalink || application.filledForCustomer)
      return  {}
    return { stop: true }
  }

  const analyst = yield this.bot.getResource(application.analyst)
  const analystID = analyst.owner._permalink
  if (masterUser) {
    if (masterUser.id !== analystID) return { done: true }
  }
  else if (user.id !== analystID) return { done: true }
  return {}
})
proto._getSyncBundle = co(function* ({ masterUser, user, allUsers }) {
  let applications = []
  if (allUsers) {
    allUsers.forEach(u => applications.push(...u.applications))
    applications.sort((a, b) => a.started - b.started)
  }
  let apps = yield Promise.all(applications.map(app => this.bot.getResource({ permalink: app.statePermalink, type: APPLICATION }, { backlinks: ['submissions'] })))
  const models = this.bot.models

  let allSubmissions = apps.map(app => app.submissions)
  let appSubmissions = []
  allSubmissions.forEach(submissions => {
    submissions.sort((a, b) => b._time - a._time)
    let fs = submissions.filter((s, i) => {
      if (!i  ||  s.submission[TYPE] !== APPLICATION_SUBMITTED)
        return true
      return submissions[i-1].submission[TYPE] !== APPLICATION_SUBMITTED
    })
    appSubmissions.push(fs)
  })

  let submissions = appSubmissions.reduce((a, b) => {
    return a.concat(b)
  }, []).filter(s => {
    const sType = s.submission[TYPE]
    const model = models[sType]
    return !DEVICE_SYNC_EXCLUDE.includes(sType) &&
          !isSubClassOf({ subModel: CHECK, models, model }) &&
          !isSubClassOf({ subModel: CHECK_OVERRIDE, models, model })
  })

  submissions.sort((a, b) => a._time - b._time)

  let forms = yield Promise.all(submissions.map(s => this.bot.getResource(s.submission)))

  forms.forEach((form, i) => {
    if (!form.contextId  &&  !form.context)
      form._contextId = submissions[i].context
  })
  let bundle = yield this.bot.draft({ type: DEVICE_SYNC_DATA_BUNDLE }).set({
    items: { items: forms }
  }).signAndSave()
  return yield bundle.toJSON()
})
proto._onShareRequest = function ({ req }) {
  const { user, object, message } = req
  this.logger.debug(`processing ${SHARE_REQUEST}`, object)
  const other = {
    originalSender: user.id
  }

  if (message.context) other.context = message.context

  return Promise.all(
    object.with.map(identityStub => {
      const { permalink } = parseStub(identityStub)
      this.logger.debug(`sharing`, {
        links: object.links,
        with: permalink
      })

      const batch = object.links.map(link => ({
        req,
        to: permalink,
        link,
        other
      }))
      // send ShareRequest along
      batch.push({ req, to: permalink, link: object._link, other })
      return this.productsAPI.sendBatch(batch)
    })
  )

  // return Promise.all(object.links.map(link => {
  //   return Promise.all(object.with.map(identityStub => {
  //     const { permalink } = parseStub(identityStub)
  //     this.logger.debug(`sharing`, {
  //       link,
  //       with: permalink
  //     })

  //     return this.productsAPI.send({
  //       req,
  //       to: permalink,
  //       link,
  //       other
  //     })
  //   }))
  // }))
}

proto.forwardToEmployee = function forwardToEmployee ({ req, object, from, to, other = {} }) {
  // const other = getCustomMessageProperties(message)
  // delete other.forward
  const message = req && req.message
  if (!object && message) {
    object = this._wrapForEmployee ? message : message.object
  }

  if (!other.context && message && message.context) {
    this.logger.debug(`propagating context ${message.context} on forwarded message`)
    other.context = message.context
  }

  if (from && !other.originalSender) {
    other.originalSender = from.id || from
  }
  // return this.productsAPI.send({ req, to, object, other })
  let toHash = to
  if (typeof to === 'object') {
    if (to[TYPE] === CUSTOMER)
      toHash = to.id
    else
      this.logger.debug(`forwarding to: ${to[TYPE]}`)
  }
  return this.bot.getResource({ [TYPE]: IDENTITY, _permalink: toHash, _link: toHash })
    .then(result => {
      let { pubkeys } = result
      let employeeHashes = [to]
      pubkeys.forEach(pkey => {
        if (pkey.importedFrom  &&  pkey.importedFrom !== to)
          employeeHashes.push(pkey.importedFrom)
      })

      return Promise.all(employeeHashes.map(to => this.productsAPI.send({ req, to, object, other })))
    })
}

proto.hasEmployees = function hasEmployees () {
  return this.listEmployees({ limit: 1 }).then(items => items.length > 0)
}

proto.list = proto.listEmployees = co(function*(opts = {}) {
  const { limit } = opts
  const { items } = yield this.bot.db.find({
    filter: {
      EQ: {
        [TYPE]: EMPLOYEE_PASS,
        _author: yield this.bot.getMyPermalink()
      },
      NEQ: {
        revoked: true
      }
    },
    orderBy: {
      property: '_time',
      desc: true
    },
    limit
  })

  return items || []
})

proto.assignRelationshipManager = co(function*({
  req,
  applicant,
  relationshipManager,
  assignment,
  application
}) {
  const { bot, productsAPI } = this
  const rmID = relationshipManager.id || relationshipManager
  const rms = application.analyst // application.relationshipManagers || []

  if (rms && rms === getPermalinkFromStub(rms)) {
    this.logger.debug('ignoring request to assign existing relationship manager')
    return
  }

  // const alreadyAssigned = rms.some(stub => getPermalinkFromStub(stub) === rmID)
  // if (alreadyAssigned) {
  //   this.logger.debug('ignoring request to assign existing relationship manager')
  //   return
  // }

  // ;[applicant, relationshipManager] = yield [
  [applicant, relationshipManager] = yield [applicant, relationshipManager].map(userOrId => {
    if (typeof userOrId === 'string')
      return bot.users.get(userOrId)
    return Promise.resolve(userOrId)
  })

  this.logger.debug(`assigning relationship manager ${rmID} to user ${applicant.id}`)
  const stub = getUserIdentityStub(relationshipManager)

  const { masterUser, user, allUsers } = req

  let ownerHash
  if (masterUser)
    ownerHash = masterUser.id
  else
    ownerHash = stub._permalink

  const employee = yield this.bot.db.findOne({
    filter: {
      EQ: {
        [TYPE]: EMPLOYEE_PASS,
        'owner._permalink': ownerHash
      }
    }
  })
  const { analyst } = application
  if (analyst && analyst._link === employee._link) {
    this.logger.debug('ignoring request to assign existing relationship manager')
    return
  }
  application.analyst = buildResourceStub({ resource: employee, models: bot.models })
  // application.reviewer = stub
  // application.relationshipManagers = rms

  const { context } = application

  let promises = []
  promises.push(this.mutuallyIntroduce({
    req,
    a: applicant,
    b: user,
    context
  }))
  promises.push(productsAPI.send({
    req,
    to: user,
    object: createVerificationForDocument(assignment),
    other: { context }
  }))
/*
  let idx = allUsers ? allUsers.findIndex(u => u.id !== user.id) : -1

  let pairedManagers
  if (idx !== -1)
    pairedManageres = allUsers.slice().splice(idx, 1)

  if (pairedManagers  &&  pairedManagers.length) {
    pairedManagers.forEach(rm => {
      promises.push(this.mutuallyIntroduce({
          req,
          a: applicant,
          b: rm,
          context
        }))
      // promises.push(productsAPI.send({
      //     req,
      //     to: rm,
      //     object: createVerificationForDocument(assignment),
      //     other: { context }
      //   }))
    })
  }

  let clientHashes =  yield this.getOtherClientIdentities({ id: applicant.id })
  clientHashes.forEach(hash => {
    promises.push(this.mutuallyIntroduce({
      req,
      a: hash,
      b: user,
      context
    }))
    if (pairedManagers) {
      debugger
      pairedManagers.forEach(ehash => {
        promises.push(this.mutuallyIntroduce({
          req,
          a: hash,
          b: ehash,
          context
        }))
      })
    }
  })
  */
  yield Promise.all(promises)
})

// auto-approve first employee
proto._onFormsCollected = co(function*({ req, user, application }) {
  if (this.isEmployee(req) || application.requestFor !== EMPLOYEE_ONBOARDING) {
    return
  }

  let approve = this._approveAll
  if (!approve) {
    const hasAtLeastOneEmployee = yield this.hasEmployees()
    approve = !hasAtLeastOneEmployee
  }

  if (approve) {
    return this.hire({ req, user, application })
  }
})

// function setEntityRole (object) {
//   if (object[TYPE] === EMPLOYEE_PASS) {
//     object.entityRole = 'unspecified'
//   }
// }

// const defaultOnFormsCollected = productsAPI.removeDefaultHandler('onFormsCollected')

proto.hire = function hire ({ req, user, application }) {
  const { productsAPI } = this
  if (this.isEmployee(req)) {
    this.logger.debug(`user ${user.id} is already an employee`)
    return
  }

  if (!application) {
    application = productsAPI.state.getApplicationsByType(user.applications, EMPLOYEE_ONBOARDING)[0]

    if (!application) {
      throw new Error(`user ${user.id} has no ${EMPLOYEE_ONBOARDING} application`)
    }
  }

  this.logger.debug('approving application for employee', {
    application: application._permalink
  })

  return productsAPI.approveApplication({ req, user, application })
}

proto.fire = function fire ({ req, user, application }) {
  const { productsAPI } = this
  if (!this.isEmployee(req)) {
    throw new Error(`user ${user.id} is not an employee`)
  }

  if (application) {
    application = user.applicationsApproved.find(app => app._permalink === application._permalink)
  } else {
    application = user.applicationsApproved.find(app => app.requestFor === EMPLOYEE_ONBOARDING)
  }

  removeEmployeeRole(user)
  this.logger.debug('revoking application for employee', {
    application: application._permalink
  })

  return productsAPI.revokeCertificate({ req, user, application })
}

proto.mutuallyIntroduce = co(function*({ req, a, b, context }) {
  const { bot, productsAPI } = this
  const aPermalink = a.id || a
  const bPermalink = b.id || b
  const getUserA = typeof a === 'string' ? bot.users.get(a) : a
  const getUserB = typeof b === 'string' ? bot.users.get(b) : b
  const [aIdentity, bIdentity] = yield [
    bot.addressBook.byPermalink(aPermalink),
    bot.addressBook.byPermalink(bPermalink)
  ]

  const [userA, userB] = yield [getUserA, getUserB]
  const introduceA = createIntroductionToUser({ user: a, identity: aIdentity })
  const introduceB = createIntroductionToUser({ user: b, identity: bIdentity })
  const other = { context }
  yield [
    productsAPI.send({
      req,
      to: userA,
      object: introduceB,
      other
    }),
    productsAPI.send({
      req,
      to: userB,
      object: introduceA,
      other
    })
  ]
})

proto._willSend = function _willSend (opts) {
  const { req = {}, other = {} } = opts
  const { message = {} } = req
  const { originalSender } = message
  if (originalSender) {
    this.logger.debug('setting "forward" based on original sender', { originalSender })
    other.forward = originalSender
    // in case it was null
    opts.other = other
  }
}

// forward any messages sent by the bot
// to relationship managers
proto._didSend = co(function*(input, sentObject) {
  const soType = sentObject[TYPE]
  if (soType === INTRODUCTION) return

  const { req, to, application } = input
  if (!application) return

  const originalRecipient = to.id || to
  if (originalRecipient !== getPermalinkFromStub(application.applicant)) {
    if (!this._isMyIdentity(req)) return
  }
  const other = clone(input.other || {})
  other.originalRecipient = originalRecipient
  const { user, masterUser } = req
  let isEmployee = this.isEmployee({ user, masterUser })
  if (isEmployee) {
    this._didSendToEmployee({ sentObject, req, other })
    return
  }

  if (soType === FORM_REQUEST    ||
      soType === FORM_ERROR      ||
      soType === APPROVAL        ||
      soType === DENIAL          ||
      soType === PRODUCT_REQUEST ||
      soType === APPLICATION_SUBMITTED ||
      // check of the message is sent from server like 'Application is in review'
      (soType === SIMPLE_MESSAGE  &&  sentObject._author !== user.id)) {
    let pairedHashes = yield this._getPairedIdentitiesHashes(req)
    if (pairedHashes.length)
      pairedHashes.forEach(to => req.sendQueue.push({ req, to, object: sentObject, other }))
  }
  else {
    // debugger
    return
  }

  const { analyst } = application
  if (!analyst) return

  // const originalRecipient = to.id || to
  // if (originalRecipient !== getPermalinkFromStub(application.applicant)) {
  //   return
  // }

  // const other = clone(input.other || {})
  // other.originalRecipient = originalRecipient

  const employeePass = yield this.bot.getResource(analyst)
  let employee = employeePass.owner
  yield [employee].map(
    co(function*(stub) {
      const userId = getPermalinkFromStub(stub)
      // avoid infinite loop of sending to the same person
      // and then forwarding, and then forwarding, and then forwarding...
      if (other.originalSender === userId || other.originalRecipient === userId) {
        return
      }

      this.logger.debug(`cc'ing`, {
        type: sentObject[TYPE],
        to: 'rm',
        author: 'this bot',
        recipient: userId,
        originalRecipient: other.originalRecipient
      })
      let employeeHashes = yield this._getEmployeeDevicesHashes(stub)
      let idx = employeeHashes.indexOf(req.user.id)
      if (idx !== -1)
        employeeHashes.splice(idx, 1)
      // debugger
      ;[userId].concat(employeeHashes).map(to => req.sendQueue.push({ req, to, object: sentObject, other }))
    }).bind(this))

  return false
})
proto._didSendToEmployee = co(function*({ sentObject, req, other }) {
  const soType = sentObject[TYPE]
  let model = this.bot.models[soType]
  let forwardToClient
  if (soType === VERIFICATION) {
    if (sentObject.document[TYPE] !== ASSIGN_RM)
      forwardToClient = true

    // let employeeHashes = yield this._getPairedIdentitiesHashes(req)
    // let { user } = req
    // let idx = employeeHashes.indexOf(user.id)
    // if (idx !== -1)
    //   employeeHashes.splice(idx, 1)
    // if (employeeHashes.length)
    //   employeeHashes.forEach(to => req.sendQueue.push({ req, to, object: sentObject, other }))
  }
  if (forwardToClient  ||  model.subClassOf === MY_PRODUCT) {
    const { application } = req
    const { applicant } = application
    let customerHashes =  yield this.getOtherClientIdentities({ id: applicant._permalink })
    let idx = customerHashes.indexOf(applicant._permalink)
    if (idx !== -1)
      customerHashes.splice(idx, 1)
    if (customerHashes.length)
      customerHashes.forEach(to => req.sendQueue.push({ req, to, object: sentObject, other }))
  }
})

proto._onRequestForExistingProduct = co(function*(req) {
  if (this.isEmployee(req))
    yield this.productsAPI.addApplication({ req })
})

proto._addEmployeeRole = function _addEmployeeRole (user) {
  const employeeRole = buildResource.enumValue({
    model: roleModel,
    value: 'employee'
  })

  user.roles.push(employeeRole)
  return employeeRole
}

proto.isEmployee = isEmployee

proto.haveAllSubmittedFormsBeenManuallyApproved = co(function*({ application }) {
  const verifications = yield this.productsAPI.getVerifications({ application })
  const formStubs = (application.forms || []).map(appSub => parseStub(appSub.submission))
  const verified = verifications.map(verification => parseStub(verification.document))
  const unverified = formStubs.filter(a => !verified.find(b => a.permalink === b.permalink))
  if (unverified.length) return false

  const verifiersInfo = verifications.map(v => ({
    form: parseStub(v.document),
    verifier: v._verifiedBy
  }))

  const verifierPermalinks = uniqueStrings(verifiersInfo.map(({ verifier }) => verifier))
  const verifiers = yield verifierPermalinks.map(_permalink =>
    this.bot.db.get({
      [TYPE]: IDENTITY,
      _permalink
    })
  )

  const employeeIds = verifiers
    .map((user, i) => this.isEmployee({ user }) && verifierPermalinks[i])
    .filter(notNull)

  return formStubs.every(formStub =>
    verifications
      .filter(v => parseStub(v.document).link === formStub.link)
      .find(({ _verifiedBy }) => employeeIds.includes(_verifiedBy))
  )
})
proto._getEmployeeDevicesHashes = co(function*(stub) {
  let masterEmployeeIdentity = yield this.bot.addressBook.byPermalink(stub._permalink)
  let pairedPubs = masterEmployeeIdentity.pubkeys.filter(pub => pub.importedFrom)
  return pairedPubs.length ? pairedPubs.map(pub => pub.importedFrom) : []
})

proto._getPairedIdentitiesHashes = co(function*(req) {
  const { user, allUsers } = req
  let hashes = []
  if (allUsers)
    allUsers.forEach(u => {
      if (u.id !== user.id) hashes.push(u.id)
    })
  return hashes
})
proto._isMyIdentity = co(function*(req) {
  const { masterUser, allUsers, user } = req
  if (!masterUser) return false
  return allUsers && allUsers.some(u => user.id === u.id)
})
