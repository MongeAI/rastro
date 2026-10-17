function formatPrice(value) {
  return currency(value) + ' BRL';
}

function currency(value) {
  return value.toFixed(2);
}

module.exports = { formatPrice, currency };
