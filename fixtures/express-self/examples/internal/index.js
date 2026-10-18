'use strict';

// lib/express.js é o código do Express, mas não é o ponto de entrada do package.json:
// sem essa prova, nenhuma rota é afirmada (a chamada continua resolvida normalmente)
var express = require('../../lib/express');

var app = express();

app.get('/internal', function (req, res) {
  res.send('ok');
});
