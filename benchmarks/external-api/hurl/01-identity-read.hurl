GET {{base_url}}/users/me
Authorization: Bearer {{admin_token}}
HTTP 200
[Asserts]
jsonpath "$.data.id" exists

GET {{base_url}}/items/orders
Authorization: Bearer {{admin_token}}
HTTP 200
[Asserts]
jsonpath "$.data" isCollection
