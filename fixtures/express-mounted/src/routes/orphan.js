const express = require('express');

// nunca montado: o caminho completo não é conhecido
const orphan = express.Router();
orphan.get('/lost', (req, res) => res.end());

module.exports = orphan;
