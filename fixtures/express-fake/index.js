'use strict';

// não é o Express: um pequeno cache com get/use
module.exports = function make() {
  return {
    get(name, cb) {
      return cb;
    },
    use() {},
  };
};
