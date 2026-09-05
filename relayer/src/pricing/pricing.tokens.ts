/**
 * DI tokens for the pricing module, kept in a dependency-free leaf file.
 *
 * Importing a token must not pull in `pricing.module` (which registers the quote
 * service/controller), otherwise the module <-> service import cycle hits a
 * temporal-dead-zone ReferenceError at runtime when the token is a `const`. Both
 * the module and its consumers import the token from here.
 */
export const PRICE_ORACLE = 'PRICE_ORACLE';
