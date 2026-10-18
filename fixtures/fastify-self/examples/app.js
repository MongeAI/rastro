'use strict';

const fastify = require('../fastify')();

fastify.get('/hello', async function () {
  return { hello: 'world' };
});

fastify.register(
  function (instance, options, done) {
    instance.get('/ping', async () => 'pong');
    done();
  },
  { prefix: '/v1' },
);
