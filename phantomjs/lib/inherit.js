
module.exports = inherit;

function inherit(Constructor, Parent, methods, properties) {
  Constructor.prototype = Object.create(Parent.prototype, properties || {});
  Object.keys(methods || {})
    .forEach(function(name) {
      Constructor.prototype[name] = methods[name];
    });

  return Constructor;
}
