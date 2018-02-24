const _ = require('lodash')
const bindAll = require('bindall')
const co = require('co').wrap
const { TYPE, SIG } = require('@tradle/constants')
const { parseId, parseStub, omitVirtual } = require('@tradle/validate-resource').utils
const EmployeeManager = require('./manager')
const {
  defaultLogger,
  getPermalinkFromStub
} = require('./utils')

const {
  EMPLOYEE_ONBOARDING,
  EMPLOYEE_PASS,
  ASSIGN_RM,
  APPROVAL,
  DENIAL,
  INTRODUCTION,
  SHARE_REQUEST,
  VERIFICATION,
  APPLICATION,
  FORM_REQUEST,
  FORM_ERROR
} = require('./types')

const ACTION_TYPES = [
  ASSIGN_RM,
  VERIFICATION,
  APPROVAL,
  DENIAL,
  FORM_ERROR,
  FORM_REQUEST
]

const isActionType = type => ACTION_TYPES.includes(type)
const alwaysTrue = () => true
const createPlugin = opts => {
  opts = _.clone(opts)
  if (!opts.logger) opts.logger = defaultLogger
  const { productsAPI, logger=defaultLogger } = opts
  const plugin = new Plugin(opts)

  let unsubscribe
  let handlingMessages
  const handleMessages = (handle=true) => {
    if (handle === handlingMessages) return
    if (!handle) return unsubscribe()

    const subscriptions = [
      productsAPI.plugins.use(_.pick(plugin, [
        'onFormsCollected', 'willSend', 'didSend', 'didApproveApplication'
      ])),

      // prepend
      productsAPI.plugins.use(_.pick(plugin, ['onmessage', 'deduceApplication'], true))
    ]

    unsubscribe = () => subscriptions.forEach(unsub => unsub())
  }

  return {
    manager: plugin.manager,
    plugin,
    handleMessages
  }
}

function Plugin ({
  bot,
  productsAPI,
  conf={},
  logger,
  manager
}) {
  bindAll(this)

  this.manager = manager || new EmployeeManager({ bot, productsAPI, logger })
  this.bot = bot
  this.logger = logger
  this.conf = conf || {}
  this._shouldForwardFromEmployee = conf.shouldForwardFromEmployee || alwaysTrue
  this._shouldForwardToEmployee = conf.shouldForwardToEmployee || alwaysTrue
}

Plugin.prototype.onmessage = co(function* (req) {
  const { bot, logger, productsAPI, manager } = this
  const { user, application, applicant, message } = req
  logger.debug(
    'processing message, custom props:',
    _.pick(message, ['originalSender', 'forward'])
  )

  const { object, forward } = message
  const type = object[TYPE]
  // forward from employee to customer
  if (manager.isEmployee(user)) {
    if (application) {
      if (type === APPROVAL || type === DENIAL) {
        yield manager.approveOrDeny({
          req,
          judge: user,
          applicant,
          application,
          judgment: object
        })

        return
      }

      if (type === VERIFICATION) {
        // defer to bot-products to import
        return
      }

      if (type === FORM_REQUEST) {
        yield manager.productsAPI.requestItem({
          req,
          user: applicant,
          application,
          item: _.omit(omitVirtual(object), SIG),
          other: { originalSender: user.id }
        })

        return
      }

      if (type === FORM_ERROR) {
        yield manager.productsAPI.requestEdit({
          req,
          user: applicant,
          application,
          details: _.omit(omitVirtual(object), SIG),
          other: { originalSender: user.id }
        })

        return
      }
    }

    // assign relationship manager
    if (type === ASSIGN_RM) {
      yield this._maybeAssignRM({ req, assignment: object })
      return
    }

    if (type === SHARE_REQUEST) {
      logger.debug(`processing ${SHARE_REQUEST}`, object)
      const other = {
        originalSender: user.id
      }

      if (message.context) other.context = message.context

      yield manager.share({
        req,
        links: object.links,
        with: object.with,
        other
      })

      return
    }
  }

  if (forward) {
    yield this._maybeForwardToOrFromEmployee({ req, forward })
    // prevent default processing
    logger.debug('preventing further processing of inbound message')
    return false
  }

  if (!application) {
    yield this._maybeForwardByContext({ req })
    return
  }

  // forward from customer to relationship manager
  const { relationshipManagers } = application
  if (!relationshipManagers) return

  yield relationshipManagers.map(co(function* (stub) {
    const rmPermalink = getPermalinkFromStub(stub)
    logger.debug('forwarding', {
      to: 'rm',
      type,
      context: message.context,
      author: user.id,
      recipient: rmPermalink
    })

    yield manager.forwardToEmployee({
      req,
      from: req.user,
      to: rmPermalink
    })
  }).bind(this))
})

/**
 * Attempt to detect the employee to forward the message to based on the "context"
 *
 */
Plugin.prototype._maybeForwardByContext = co(function* ({ req }) {
  const { manager } = this
  const { user, context } = req
  const employee = yield manager.getEmployeeFromContext(req)
  if (!employee) return

  const type = req.message.object[TYPE]
  this.logger.debug('forwarding', {
    to: 'guessed employee based on context',
    type,
    context,
    author: user.id,
    recipient: employee.id
  })

  yield this.forwardToEmployee({
    req,
    from: req.user,
    to: employee,
    other: { context }
  })
})

Plugin.prototype._maybeForwardToOrFromEmployee = co(function* ({ req, forward }) {
  const { bot, manager, logger } = this
  const { user, message } = req
  const { object } = message
  const type = object[TYPE]
  if (manager.isEmployee(user)) {
    const myIdentity = yield bot.getMyIdentity()
    if (myIdentity._permalink === forward) {
      logger.debug(`not forwarding ${type} ${object._link} to self`)
      return
    }

    const shouldForward = yield Promise.resolve(
      this._shouldForwardFromEmployee({ req })
    )

    if (!shouldForward) {
      logger.debug(`not forwarding ${type} from employee ${user.id} to ${forward}`)
      return
    }

    logger.debug('forwarding', {
      to: 'customer (specified by employee in message.forward)',
      type: type,
      context: message.context,
      author: user.id,
      recipient: forward
    })

    yield manager.reSignAndForward({
      req,
      from: user,
      to: forward,
      message,
      myIdentity
    })

    return
  }

  let recipient
  try {
    recipient = yield bot.users.get(forward)
  } catch (err) {
    this.logger.debug(`final recipient ${forward} specified in "forward" was not found`)
    return
  }

  if (!this.isEmployee(recipient)) {
    this.logger.debug(`refusing to forward: neither sender "${user.id}" nor recipient "${forward}" is an employee`)
    return
  }

  const shouldForward = yield Promise.resolve(
    this._shouldForwardToEmployee({ req })
  )

  if (!shouldForward) {
    this.logger.debug(`not forwarding ${type} from ${user.id} to employee ${forward}`)
    return
  }

  this.logger.debug('forwarding', {
    to: 'employee (specified in message.forward)',
    type: type,
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
  // yield this.reSignAndForward({ req, to: forward })
})

Plugin.prototype.deduceApplication = co(function* (req) {
  const { bot, manager, logger } = this
  const { user, message={} } = req
  if (!manager.isEmployee(user)) return

  const { context, forward, object } = message
  const type = object[TYPE]
  if (type === ASSIGN_RM || type == APPROVAL || type === DENIAL) {
    return yield manager.productsAPI.getApplicationByStub(object.application)
  }

  const isAction = isActionType(type)
  if (forward && !isAction) {
    // ignore
    return false
  }

  if (!(context && isAction)) return

  try {
    return yield bot.db.findOne({
      filter: {
        EQ: {
          [TYPE]: APPLICATION,
          context: req.context
        }
      }
    })
  } catch (err) {
    logger.debug('failed to get application by context', err.stack)
  }
})

Plugin.prototype.willSend = function (opts) {
  const { logger } = this
  const { req={}, other={} } = opts
  const { message={} } = req
  const { originalSender } = message
  if (originalSender) {
    logger.debug('setting "forward" based on original sender', { originalSender })
    other.forward = originalSender
    // in case it was null
    opts.other = other
  }
}

Plugin.prototype.didSend = co(function* (input, sentObject) {
  const { manager, logger } = this
  if (sentObject[TYPE] === INTRODUCTION) return

  const { req, to, application } = input
  if (!application) return

  const { relationshipManagers } = application
  if (!(relationshipManagers && relationshipManagers.length)) return

  const originalRecipient = to.id || to
  if (originalRecipient !== getPermalinkFromStub(application.applicant)) {
    return
  }

  const other = _.clone(input.other || {})
  other.originalRecipient = originalRecipient

  yield relationshipManagers.map(co(function* (stub) {
    const userId = getPermalinkFromStub(stub)
    // avoid infinite loop of sending to the same person
    // and then forwarding, and then forwarding, and then forwarding...
    if (other.originalSender === userId || other.originalRecipient === userId) {
      return
    }

    logger.debug(`cc'ing`, {
      type: sentObject[TYPE],
      to: 'rm',
      author: 'this bot',
      recipient: userId,
      originalRecipient: other.originalRecipient
    })

    // nothing to unwrap here, this is an original from our bot
    yield manager.forwardToEmployee({
      req,
      other,
      object: sentObject,
      to: userId
    })
  }))
})

Plugin.prototype.didApproveApplication = ({ req, user, application }, certificate) => {
  if (certificate[TYPE] == EMPLOYEE_PASS) {
    this.manager.addEmployeeRole(user)
  }
}

// auto-approve first employee
Plugin.prototype.onFormsCollected = co(function* ({ req, user, application }) {
  const { manager } = this
  if (manager.isEmployee(user) || application.requestFor !== EMPLOYEE_ONBOARDING) {
    return
  }

  let approve = this.conf.approveAll
  if (!approve) {
    const hasAtLeastOneEmployee = yield manager.hasEmployees()
    approve = !hasAtLeastOneEmployee
  }

  if (approve) {
    return manager.hire({ req, user, application })
  }
})

Plugin.prototype._maybeAssignRM = co(function* ({ req, assignment }) {
  const { bot, productsAPI, manager, logger } = this
  const { user, application, applicant } = req
  if (!manager.isEmployee(user)) {
    logger.debug(`refusing to assign relationship manager as sender "${user.id}" is not an employee`)
    return
  }

  const relationshipManager = getPermalinkFromStub(assignment.employee)
  yield manager.assignRelationshipManager({
    req,
    applicant,
    assignment,
    relationshipManager: relationshipManager === user.id ? user : relationshipManager,
    application
  })
})

module.exports = {
  Plugin,
  createPlugin
}
