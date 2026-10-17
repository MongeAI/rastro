const rows = [];

exports.all = () => rows;
exports.find = (id) => rows.find((row) => row.id === id);
exports.insert = (row) => {
  rows.push(row);
  return row;
};
