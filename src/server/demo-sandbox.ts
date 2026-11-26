import { Hono } from "hono";

/**
 * 构建一份真实的 8 端点电商微服务 OpenAPI 3.0.3 规范，
 * 用于开箱即用的大文档检索（OpenApiIndex）、多场景 API 联调排错与审批演示。
 */
export function buildDemoOpenApiSpec(baseUrl: string): Record<string, unknown> {
  return {
    openapi: "3.0.3",
    info: {
      title: "A-Pidoc Commerce Diagnostic Sandbox API",
      version: "2.0.0",
      description: "Multi-endpoint sandbox service for API debugging, schema validation, auth diagnostics, and HITL mutation approval."
    },
    servers: [{ url: baseUrl }],
    paths: {
      "/sandbox/health": {
        get: {
          operationId: "getHealth",
          tags: ["system"],
          summary: "Check sandbox service health",
          responses: { "200": { description: "Healthy" } }
        }
      },
      "/sandbox/orders": {
        post: {
          operationId: "createOrder",
          tags: ["orders"],
          summary: "Create a checkout order",
          description: "Requires application/json Content-Type, positive numeric amount, and ISO currency code.",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["sku", "amount", "currency"],
                  properties: {
                    sku: { type: "string", minLength: 2 },
                    amount: { type: "number", minimum: 1 },
                    currency: { type: "string", enum: ["CNY", "USD"] }
                  }
                }
              }
            }
          },
          responses: {
            "201": { description: "Order created" },
            "400": { description: "Validation failed" },
            "415": { description: "Unsupported Media Type" }
          }
        }
      },
      "/sandbox/orders/{orderId}": {
        get: {
          operationId: "getOrderById",
          tags: ["orders"],
          summary: "Query order details by ID",
          parameters: [
            { name: "orderId", in: "path", required: true, schema: { type: "string" } }
          ],
          responses: { "200": { description: "Order found" }, "404": { description: "Not found" } }
        }
      },
      "/sandbox/payments/charge": {
        post: {
          operationId: "chargePayment",
          tags: ["payments"],
          summary: "Execute payment charge (mutating operation)",
          description: "Requires X-API-Client=checkout-svc, Idempotency-Key header, and numeric totalCents.",
          parameters: [
            { name: "X-API-Client", in: "header", required: true, schema: { type: "string" } },
            { name: "Idempotency-Key", in: "header", required: true, schema: { type: "string" } }
          ],
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["orderId", "totalCents"],
                  properties: {
                    orderId: { type: "string" },
                    totalCents: { type: "integer", minimum: 100 }
                  }
                }
              }
            }
          },
          responses: { "200": { description: "Charged" }, "401": { description: "Missing client header" } }
        }
      },
      "/sandbox/inventory/check": {
        post: {
          operationId: "checkInventory",
          tags: ["inventory"],
          summary: "Check stock availability for a SKU",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["sku", "quantity"],
                  properties: {
                    sku: { type: "string" },
                    quantity: { type: "integer", minimum: 1 }
                  }
                }
              }
            }
          },
          responses: { "200": { description: "Stock checked" } }
        }
      },
      "/sandbox/users/profile": {
        get: {
          operationId: "getUserProfile",
          tags: ["users"],
          summary: "Fetch user profile by userId query parameter",
          parameters: [
            { name: "userId", in: "query", required: true, schema: { type: "string" } }
          ],
          responses: { "200": { description: "Profile returned" } }
        }
      },
      "/sandbox/coupons/validate": {
        post: {
          operationId: "validateCoupon",
          tags: ["marketing"],
          summary: "Validate a promotional coupon code",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["code"],
                  properties: { code: { type: "string" } }
                }
              }
            }
          },
          responses: { "200": { description: "Coupon status" }, "429": { description: "Rate limited" } }
        }
      },
      "/sandbox/shipping/quote": {
        post: {
          operationId: "calculateShippingQuote",
          tags: ["shipping"],
          summary: "Estimate shipping cost by region and weightGrams",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["region", "weightGrams"],
                  properties: {
                    region: { type: "string", enum: ["CN-BJ", "CN-SH", "US-CA"] },
                    weightGrams: { type: "number", minimum: 10 }
                  }
                }
              }
            }
          },
          responses: { "200": { description: "Shipping quote" } }
        }
      }
    }
  };
}

/** 挂载到 Hono 的多端点诊断靶场路由 */
export function createDemoSandboxRoutes(): Hono {
  const app = new Hono();

  app.get("/health", (c) => c.json({ ok: true, service: "a-pidoc-sandbox", endpoints: 8 }));

  app.post("/orders", async (c) => {
    const contentType = c.req.header("content-type") ?? "";
    if (!contentType.toLowerCase().includes("application/json")) {
      return c.json(
        {
          error: "UNSUPPORTED_MEDIA_TYPE",
          message: "Content-Type header must be application/json."
        },
        415
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await c.req.json()) as Record<string, unknown>;
    } catch {
      return c.json({ error: "INVALID_JSON", message: "Request body is not valid JSON." }, 400);
    }

    if (typeof body.sku !== "string" || body.sku.length < 2) {
      return c.json({ error: "VALIDATION_ERROR", field: "sku", message: "sku must be a non-empty string." }, 400);
    }
    if (typeof body.amount !== "number" || !Number.isFinite(body.amount) || body.amount < 1) {
      return c.json(
        { error: "VALIDATION_ERROR", field: "amount", message: "amount must be a positive number (got " + typeof body.amount + ")." },
        400
      );
    }
    if (body.currency !== "CNY" && body.currency !== "USD") {
      return c.json(
        { error: "VALIDATION_ERROR", field: "currency", message: "currency must be one of: CNY, USD." },
        400
      );
    }

    return c.json(
      {
        orderId: "ord_demo_2026",
        sku: body.sku,
        amount: body.amount,
        currency: body.currency,
        status: "validated"
      },
      201
    );
  });

  app.get("/orders/:orderId", (c) => {
    const orderId = c.req.param("orderId");
    if (orderId === "ord_demo_2026") {
      return c.json({ orderId, sku: "SKU-100", amount: 99, currency: "CNY", status: "validated" });
    }
    return c.json({ error: "NOT_FOUND", message: `Order ${orderId} not found.` }, 404);
  });

  app.post("/payments/charge", async (c) => {
    const client = c.req.header("x-api-client");
    const idempotencyKey = c.req.header("idempotency-key");
    if (client !== "checkout-svc") {
      return c.json(
        { error: "UNAUTHORIZED_CLIENT", message: "Header X-API-Client must equal checkout-svc." },
        401
      );
    }
    if (!idempotencyKey || idempotencyKey.trim().length < 4) {
      return c.json(
        { error: "MISSING_IDEMPOTENCY_KEY", message: "Header Idempotency-Key is required for payment charges." },
        400
      );
    }
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.orderId !== "string" || typeof body.totalCents !== "number" || body.totalCents < 100) {
      return c.json(
        { error: "VALIDATION_ERROR", message: "orderId (string) and totalCents (integer >= 100) are required." },
        400
      );
    }
    return c.json({
      chargeId: "chg_sandbox_ok",
      orderId: body.orderId,
      totalCents: body.totalCents,
      idempotencyKey,
      status: "charged_in_sandbox"
    });
  });

  app.post("/inventory/check", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.sku !== "string" || typeof body.quantity !== "number") {
      return c.json({ error: "VALIDATION_ERROR", message: "sku (string) and quantity (number) required." }, 400);
    }
    return c.json({ sku: body.sku, requested: body.quantity, available: 42, inStock: body.quantity <= 42 });
  });

  app.get("/users/profile", (c) => {
    const userId = c.req.query("userId");
    if (!userId) {
      return c.json({ error: "MISSING_QUERY", message: "Query parameter userId is required." }, 400);
    }
    return c.json({ userId, tier: "pro", region: "CN-BJ" });
  });

  app.post("/coupons/validate", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.code !== "string") {
      return c.json({ error: "VALIDATION_ERROR", message: "code (string) is required." }, 400);
    }
    return c.json({ code: body.code, valid: body.code === "SAVE20", discountPercent: body.code === "SAVE20" ? 20 : 0 });
  });

  app.post("/shipping/quote", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body.region !== "string" || typeof body.weightGrams !== "number") {
      return c.json({ error: "VALIDATION_ERROR", message: "region and weightGrams required." }, 400);
    }
    return c.json({ region: body.region, weightGrams: body.weightGrams, feeCny: 12 });
  });

  return app;
}
