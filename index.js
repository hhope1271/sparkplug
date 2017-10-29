const _ = require('lodash')
const DocumentClient = require('aws-sdk').DynamoDB.DocumentClient

const dynamoPromise = (client, operation, payload) => {
  return new Promise((resolve, reject) => {
    client[operation](payload, (err, resp) => {
      let formattedResponse = null
      if (err !== null) {
        return reject(err)
      }
      if (resp.Item) {
        formattedResponse = resp.Item
      } else if (resp.Responses) {
        formattedResponse = resp.Responses
      } else {
        formattedResponse = resp
      }
      return resolve(formattedResponse)
    })
  })
}

const deconstruct = (obj) => {
  return _(obj)
    .reduce((result, value, key) => {
      const ref = `:${key}`
      result.values[ref] = value
      result.expression.push((_.isArray(value)
        ? `contains(${key}, ${ref})`
        : `${key} = ${ref}`
      ))
      return result
    }, {expression: [], values: {}})
    .tap(({expression, values}) => {
      return {
        expression: expression.join(' AND '),
        values
      }
    })
    .value()
}

const batchWrite = (op, that, table, items) => {
  if (!that._put[table.name]) {
    that._put[table.name] = []
  }
  const values = _.castArray(items).map((item) => {
    const value = {}
    value[op] = op === 'DeleteRequest' ? {Key: item} : {Item: item}
    return value
  })
  that._put[table.name] = that._put[table.name].concat(values)
  return that
}

class Sparkplug {
  constructor (config) {
    this.client = new DocumentClient(config)
    return this
  }

  table (tableName) {
    return new Table(tableName, this.client)
  }

  batch () {
    return new Batch(this.client)
  }
}

class Batch {
  constructor (client) {
    this.client = client
    this._get = {}
    this._put = {}
    return this
  }

  get (table, keys) {
    if (!this._get[table.name]) {
      this._get[table.name] = {Keys: []}
    }
    this._get[table.name].Keys = this._get[table.name].Keys
      .concat(_.castArray(keys))
    return this
  }

  put (table, items) {
    return batchWrite('PutRequest', this, table, items)
  }

  delete (table, keys) {
    return batchWrite('DeleteRequest', this, table, keys)
  }

  exec () {
    const promises = _.filter([
      {op: 'batchGet', obj: this._get},
      {op: 'batchWrite', obj: this._put}
    ].map(({op, obj}) => {
      if (!_.isEmpty(obj)) {
        return dynamoPromise(this.client, op, {
          RequestItems: obj
        })
      } else {
        return null
      }
    }))
    if (promises.length === 1) {
      return promises[0]
    } else {
      return Promise.all(promises)
    }
  }
}

class Table {
  constructor (tableName, client) {
    this.name = tableName
    this.client = client
    return this
  }

  get (key) {
    return dynamoPromise(this.client, 'get', {
      Key: key,
      TableName: this.name
    })
  }

  put (item) {
    return dynamoPromise(this.client, 'put', {
      Item: item,
      TableName: this.name
    })
  }

  delete (key) {
    return dynamoPromise(this.client, 'delete', {
      Key: key,
      TableName: this.name
    })
  }

  query (expression, values) {
    return new Query(this, expression, values)
  }
}

class Query {
  constructor (table, expression, values) {
    this.table = table
    this.expression = {
      TableName: table.name,
      KeyConditionExpression: '',
      ExpressionAttributeValues: {}
    }
    if (_.isObject(expression)) {
      const newExpression = deconstruct(expression)
      this.KeyConditionExpression = newExpression.expression
      this.ExpressionAttributeValues = newExpression.values
    } else {
      this.KeyConditionExpression = expression
      this.ExpressionAttributeValues = values
    }
    return this
  }

  on (index) {
    this.expression.IndexName = index
    return this
  }
}

Sparkplug.Table = Table
Sparkplug.Batch = Batch
module.exports = Sparkplug