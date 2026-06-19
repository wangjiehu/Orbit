export function zodToJsonSchema(schema: any): any {
  if (!schema || !schema._def) return { type: 'object' };
  const def = schema._def;
  const typeName = def.typeName;

  switch (typeName) {
    case 'ZodObject': {
      const shape = def.shape();
      const properties: Record<string, any> = {};
      const required: string[] = [];

      for (const key of Object.keys(shape)) {
        const propertySchema = shape[key];
        properties[key] = zodToJsonSchema(propertySchema);

        let isOptional = false;
        let inner = propertySchema;
        while (inner && inner._def) {
          if (inner._def.typeName === 'ZodOptional') {
            isOptional = true;
            break;
          }
          inner = inner._def.innerType || inner._def.schema;
        }

        if (!isOptional) {
          required.push(key);
        }
      }

      return {
        type: 'object',
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
    }
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    case 'ZodArray':
      return {
        type: 'array',
        items: zodToJsonSchema(def.type),
      };
    case 'ZodOptional':
      return zodToJsonSchema(def.innerType);
    case 'ZodEffects':
      return zodToJsonSchema(def.schema);
    default:
      return { type: 'string' };
  }
}
