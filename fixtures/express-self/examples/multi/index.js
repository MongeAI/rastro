'use strict';

var express = require('../../');

var app = express();

app.use('/api', require('./api'));
