-- One-line "why" for Next up card (agents maintain per MC-AGENT-PROTOCOL)
alter table tasks add column if not exists why text;
