'use strict';

var express = require('../..');

var api = express.Router();

api.get('/users', listUsers);

function listUsers(req, res) {
  res.send([]);
}

module.exports = api;
