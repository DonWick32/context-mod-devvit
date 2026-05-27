import { Validator } from 'jsonschema';
import appSchema from '../../public/schema/App.json';
import {
  detectLegacyConfigFormat,
  parseLegacyConfigDocument,
  parseLegacyConfigText,
  summarizeConfigParseResult,
} from './legacyConfigParser';
import type { ConfigFormat, ConfigParseResult } from './legacyTypes';

export type ConfigValidationResult =
  | {
      ok: true;
      format: ConfigFormat;
      message: string;
      parseResult: Extract<ConfigParseResult, { ok: true }>;
      schemaErrors: [];
    }
  | {
      ok: false;
      format?: ConfigFormat;
      message: string;
      parseResult?: ConfigParseResult;
      schemaErrors: string[];
    };

const validator = new Validator();

const formatSchemaError = (error: { property?: string; message?: string }) => {
  const property =
    error.property === undefined || error.property === 'instance'
      ? 'root'
      : error.property.replace(/^instance\.?/, '');
  return `${property}: ${error.message ?? 'schema validation failed'}`;
};

export const validateContextModConfigText = (
  text: string,
  options: { sourceName?: string } = {}
): ConfigValidationResult => {
  const format = detectLegacyConfigFormat(text);
  const parseResult = parseLegacyConfigText(text, {
    ...(options.sourceName === undefined ? {} : { sourceName: options.sourceName }),
    format,
  });

  if (!parseResult.ok) {
    return {
      ok: false,
      format: parseResult.format ?? format,
      message: summarizeConfigParseResult(parseResult),
      parseResult,
      schemaErrors: [],
    };
  }

  const document = parseLegacyConfigDocument(text, format);
  const schemaResult = validator.validate(document, appSchema, {
    nestedErrors: true,
  });
  const schemaErrors = schemaResult.errors.map(formatSchemaError);

  if (schemaErrors.length > 0) {
    return {
      ok: false,
      format,
      message: `Invalid ContextMod config schema: ${schemaErrors[0]}`,
      parseResult,
      schemaErrors,
    };
  }

  return {
    ok: true,
    format,
    message: summarizeConfigParseResult(parseResult),
    parseResult,
    schemaErrors: [],
  };
};
