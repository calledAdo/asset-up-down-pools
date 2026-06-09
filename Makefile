UP_DOWN_DIR := crates/up_down
HOST_TARGET := x86_64-unknown-linux-gnu
CKB_TARGET  := riscv64imac-unknown-none-elf

.PHONY: contracts-build contracts-test

contracts-build:
	cd $(UP_DOWN_DIR) && cargo build -p pool_type -p share_xudt -p treasury_lock -p pool_admin_lock --release --target $(CKB_TARGET)

contracts-test:
	cd $(UP_DOWN_DIR) && cargo test --target $(HOST_TARGET)
