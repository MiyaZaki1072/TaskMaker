/**
 * Schema for the problem.yaml file
 *
 * This file is the "contract" between the problem writer and the system:
 * if a yaml file passes this schema, it is guaranteed to render to HTML/PDF.
 * Every error message is intentionally written in plain English, since most users
 * are not programmers.
 */
import { z } from 'zod';

const nonEmpty = (label: string) =>
  z
    .string({ required_error: `${label} is required`, invalid_type_error: `${label} must be text` })
    .trim()
    .min(1, `${label} is empty, please enter some text`);

const nonEmptyList = (label: string) =>
  z
    .array(nonEmpty(`each line of ${label}`), {
      required_error: `${label} is required`,
      invalid_type_error: `${label} must be a list (each line starting with -)`,
    })
    .min(1, `${label} must have at least 1 line`);

export const subtaskSchema = z.object({
  score: z
    .number({
      required_error: 'A subtask must have a score',
      invalid_type_error: 'A subtask score must be a number, e.g. 5, not "5 points"',
    })
    .int('A subtask score must be a whole number')
    .min(0, 'A subtask score cannot be negative'),
  condition: nonEmpty('the subtask condition'),
});

export const exampleSchema = z.object({
  input: nonEmpty('the example input'),
  output: nonEmpty('the example output'),
  explanation: z.string().trim().min(1).optional(),
  image: z.string().trim().min(1).optional(),
});

export const problemSchema = z
  .object({
    task: z.object(
      {
        code: nonEmpty('the problem code (task.code)'),
        name: nonEmpty('the problem name (task.name)'),
      },
      {
        required_error: 'A task section with code and name is required',
        invalid_type_error: 'The task section must contain code and name',
      },
    ),
    logo: z.string().trim().min(1).optional(),
    story: nonEmpty('the problem story'),
    input_format: nonEmptyList('the input format (input_format)'),
    output_format: nonEmptyList('the output format (output_format)'),
    constraints: nonEmptyList('the constraints'),
    subtasks: z.array(subtaskSchema).default([]),
    examples: z
      .array(exampleSchema, { required_error: 'examples is required' })
      .min(1, 'At least 1 example is required'),
    limits: z.object(
      {
        time: nonEmpty('the time limit (limits.time), e.g. "3 seconds"'),
        memory: nonEmpty('the memory limit (limits.memory), e.g. "1 GiB"'),
      },
      {
        required_error: 'A limits section with time and memory is required',
        invalid_type_error: 'The limits section must contain time and memory',
      },
    ),
    // Author name — always required
    author: nonEmpty('the author name'),
  })
  .strict();

export type Problem = z.infer<typeof problemSchema>;
export type Subtask = z.infer<typeof subtaskSchema>;
export type Example = z.infer<typeof exampleSchema>;

/** Human-readable name for each field, used to build readable error messages */
const FIELD_LABELS: Record<string, string> = {
  task: 'Problem header',
  'task.code': 'Problem code',
  'task.name': 'Problem name',
  logo: 'Logo',
  story: 'Story',
  input_format: 'Input format',
  output_format: 'Output format',
  constraints: 'Constraints',
  subtasks: 'Subtasks',
  examples: 'Examples',
  limits: 'Limits',
  'limits.time': 'Time limit',
  'limits.memory': 'Memory limit',
  author: 'Author name',
};

/** Turns a zod path (e.g. ["examples",0,"input"]) into a readable description */
export function describePath(path: (string | number)[]): string {
  if (path.length === 0) return 'the problem file';
  const dotted = path.filter((p) => typeof p === 'string').join('.');
  const label = FIELD_LABELS[dotted];
  const parts: string[] = [];
  for (let i = 0; i < path.length; i += 1) {
    const key = path[i]!;
    if (typeof key === 'number') {
      parts.push(`item ${key + 1}`);
    } else {
      parts.push(FIELD_LABELS[path.slice(0, i + 1).filter((p) => typeof p === 'string').join('.')] ?? key);
    }
  }
  return label ?? parts.join(' → ');
}

/** Converts zod errors into a list of readable messages, one issue per line */
export function formatZodIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const where = describePath(issue.path);
    const yamlPath = issue.path.length
      ? issue.path.map((p) => (typeof p === 'number' ? `[${p + 1}]` : p)).join('.')
      : '(top level of the file)';

    if (issue.code === 'unrecognized_keys') {
      return `Found unrecognized field(s): ${issue.keys.join(', ')} — check the spelling (see the valid field names in templates/problem.template.yaml)`;
    }
    if (issue.code === 'invalid_type' && issue.received === 'undefined') {
      return `${where} is missing (in the file, this is \`${yamlPath}\`) — please add this field`;
    }
    return `${where} (in the file, this is \`${yamlPath}\`): ${issue.message}`;
  });
}
