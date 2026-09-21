POST {{base_url}}/items/orders
Authorization: Bearer {{admin_token}}
Content-Type: application/json
{
  "amount": 42,
  "status": "new"
}
HTTP 200
[Captures]
order_id: jsonpath "$.data.id"

GET {{base_url}}/items/orders/{{order_id}}
Authorization: Bearer {{admin_token}}
HTTP 200
[Asserts]
jsonpath "$.data.amount" == 42
jsonpath "$.data.status" == "new"

PATCH {{base_url}}/items/orders/{{order_id}}
Authorization: Bearer {{admin_token}}
Content-Type: application/json
{
  "status": "paid"
}
HTTP 200

GET {{base_url}}/items/orders/{{order_id}}
Authorization: Bearer {{admin_token}}
HTTP 200
[Asserts]
jsonpath "$.data.status" == "paid"

DELETE {{base_url}}/items/orders/{{order_id}}
Authorization: Bearer {{admin_token}}
HTTP 204
