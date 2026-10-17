const db = require('../db');

function listUsers(req, res) {
  res.json(db.all());
}

function getUser(req, res) {
  res.json(db.find(req.params.id));
}

function createUser(body) {
  return db.insert(body);
}

module.exports = { listUsers, getUser, createUser };
