GET {{base_url}}/items/orders
Authorization: Bearer {{invalid_token}}
HTTP *
[Asserts]
status >= 401
status < 500
