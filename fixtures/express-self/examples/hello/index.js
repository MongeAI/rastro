'use strict';

var express = require('../..');

var app = module.exports = express();

app.get('/', function (req, res) {
  res.send('Hello World');
});

app
  .route('/book')
  .get(function (req, res) {
    res.send('livro');
  })
  .post(function (req, res) {
    res.send('salvo');
  });

app.use(express.static('public'));
