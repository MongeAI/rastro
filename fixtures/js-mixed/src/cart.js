exports.addItem = function (item) {
  return validate(item);
};

exports.total = (items) => items.reduce((acc, item) => acc + item.price, 0);

function validate(item) {
  return item.price > 0;
}
