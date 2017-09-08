const { TYPE } = require('@tradle/constants')

module.exports = ({ productsAPI }) => {
  const { namespace, models } = productsAPI
  const applicationModelId = models.private.application.id
  return {
    id: `${namespace}.AssignRelationshipManager`,
    title: 'Assign Relationship Manager',
    interfaces: [
      'tradle.Message'
    ],
    subClassOf: 'tradle.Form',
    type: 'tradle.Model',
    properties: {
      employee: {
        type: 'object',
        ref: 'tradle.Identity'
      },
      application: {
        type: 'object',
        ref: applicationModelId
      }
    },
    required: [
      'employee',
      'application'
    ],
    viewCols: [
      'employee',
      'application'
    ]
  }
}
