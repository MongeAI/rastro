'use strict';

// `..` é o ponto de entrada do package.json chamado "express", mas ele não exporta a fábrica
// do Express: `store.get('/config', ...)` é só um método de objeto, não uma rota
const make = require('..');

const store = make();

function onCache() {
  return 1;
}

store.get('/config', onCache);
store.use(onCache);
