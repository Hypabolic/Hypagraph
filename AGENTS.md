# Repository instructions

## Naming

Use the name `Hypagraph` for the product, package, tools, commands, types, events, files, examples, and documentation.

Do not add compatibility aliases for an old product name.

Use these Pi tool names:

- `hypagraph_define`
- `hypagraph_read`
- `hypagraph_transition`
- `hypagraph_revise`

Use `/hypagraph` for the Pi command.

## Technical English

Use ASD-STE100 Simplified Technical English for all text that is part of the repository.

This rule applies to:

- documentation;
- plans and roadmaps;
- architecture decision records;
- issue and pull request text that the repository stores;
- source code comments;
- test names and test descriptions;
- user interface text;
- error messages;
- tool descriptions and prompt guidance;
- commit messages when practical.

Apply these rules:

1. Use one instruction or one main idea in each sentence.
2. Use short sentences.
3. Use active voice.
4. Use approved technical terms consistently.
5. Do not use a different word for the same technical concept.
6. Do not use idioms, slang, jokes, metaphors, or informal abbreviations.
7. Do not use a noun as a verb when a standard verb is available.
8. Do not omit articles or other words only to make text shorter.
9. Put conditions before the instruction when this improves clarity.
10. Use lists for a sequence of actions or a set of requirements.
11. Use `must` for a requirement. Use `can` for capability. Use `may` only for permission.
12. Do not use `should` when the statement is a requirement.
13. Keep paragraphs short.
14. Define an uncommon abbreviation before its first use.
15. Review all changed prose before you commit it.

Do not claim formal ASD-STE100 conformance unless a qualified review confirms it. The repository must use the ASD-STE100 writing method as its mandatory house style.

## M0 quality rules

The domain reducer must be deterministic.

The domain reducer must not read the clock, create random values, access files, access the network, or change input objects.

All persisted state must include a schema version.

A schema change must include a migration or an explicit rejection path.

All graph definitions must pass validation before execution.

The test suite must check domain invariants and persistence restoration.
