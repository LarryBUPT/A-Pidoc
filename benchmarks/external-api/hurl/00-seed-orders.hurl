POST {{base_url}}/collections
Authorization: Bearer {{admin_token}}
Content-Type: application/json
{
  "collection": "orders",
  "meta": { "icon": "shopping_cart" },
  "schema": {}
}
HTTP 200

POST {{base_url}}/fields/orders
Authorization: Bearer {{admin_token}}
Content-Type: application/json
{
  "field": "amount",
  "type": "integer",
  "meta": { "required": true },
  "schema": { "is_nullable": false }
}
HTTP 200

POST {{base_url}}/fields/orders
Authorization: Bearer {{admin_token}}
Content-Type: application/json
{
  "field": "status",
  "type": "string",
  "meta": { "required": true },
  "schema": { "is_nullable": false, "default_value": "new" }
}
HTTP 200
