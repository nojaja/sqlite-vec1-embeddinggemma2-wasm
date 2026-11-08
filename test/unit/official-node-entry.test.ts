import initialize from "../../src/official/node";

test("official Node entry: rejects embedding on main thread before model access", async () => {
  await expect(initialize({ embedding: { model: { network: "offline" } } })).rejects.toThrow("E_ENVIRONMENT");
});