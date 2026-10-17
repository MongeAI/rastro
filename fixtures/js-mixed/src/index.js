const { formatPrice } = require('./utils/format');
const cart = require('./cart');
const Legacy = require('./legacy.cjs');

const pluginName = './plugins/' + process.env.PLUGIN;
const plugin = require(pluginName);

module.exports = function main() {
  const items = [{ price: 10 }];
  cart.addItem(items[0]);
  console.log(formatPrice(cart.total(items)));
  new Legacy().run();
  plugin.start();
};
