/**
 * SQL text handling for the migration runner, kept apart from the runner
 * itself: `migrate.ts` reaches for `import.meta.glob`, which only exists under
 * the bundler, and these need to be testable without it.
 */

/**
 * Splits one migration file into the statements D1 will accept.
 *
 * `db.exec` needs every statement on a single line, which these are not, so
 * they are split here instead. Quote tracking is what keeps a `--` or a `;`
 * inside a string literal from being mistaken for a comment or a boundary.
 */
export function splitStatements(sql: string): string[] {
	const statements: string[] = [];
	let current = '';
	let inString = false;

	for (let index = 0; index < sql.length; index += 1) {
		const character = sql[index];

		if (inString) {
			current += character;
			// '' is an escaped quote inside a string, not the end of one.
			if (character === "'") {
				if (sql[index + 1] === "'") {
					current += sql[index + 1];
					index += 1;
				} else {
					inString = false;
				}
			}
			continue;
		}

		if (character === "'") {
			inString = true;
			current += character;
			continue;
		}

		if (character === '-' && sql[index + 1] === '-') {
			const newline = sql.indexOf('\n', index);
			index = newline === -1 ? sql.length : newline;
			current += '\n';
			continue;
		}

		if (character === ';') {
			statements.push(current);
			current = '';
			continue;
		}

		current += character;
	}

	statements.push(current);
	return statements.map((statement) => statement.trim()).filter(Boolean);
}
