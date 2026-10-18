class Shape {
  area() {
    return 0;
  }
}

class Square extends Shape {
  area() {
    return super.area() + 1;
  }

  twice() {
    return this.area() * 2;
  }
}

class Cube extends Square {
  volume() {
    return this.twice() * 2;
  }
}

module.exports = { Square, Cube };
