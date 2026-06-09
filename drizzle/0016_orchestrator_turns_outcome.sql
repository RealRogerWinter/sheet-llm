ALTER TABLE `orchestrator_turns` ADD `outcome` text CHECK (outcome IN ('accepted', 'reverted', 'superseded'));
