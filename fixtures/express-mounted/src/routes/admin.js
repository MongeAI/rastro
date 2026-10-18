const express = require('express');
const { listUsers } = require('../handlers/users');

// montado duas vezes: em /api/admin e em /backoffice
const admin = express.Router();
admin.get('/stats', listUsers);

module.exports = admin;
