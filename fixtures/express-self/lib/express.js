'use strict';

exports = module.exports = createApplication;

function createApplication() {
  return { get() {}, use() {}, route() {} };
}

exports.Router = function Router() {
  return { get() {} };
};

exports.static = require('serve-static');
