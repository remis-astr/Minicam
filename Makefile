PI0 := pi0
REMOTE_DIR := /opt/minicam
SYSTEMD_DIR := /etc/systemd/system

.PHONY: deploy deploy-systemd logs restart status bootstrap

deploy:
	rsync -av --delete --exclude='__pycache__' src/ $(PI0):$(REMOTE_DIR)/src/
	rsync -av web/ $(PI0):$(REMOTE_DIR)/web/

deploy-systemd:
	rsync -av deploy/systemd/ $(PI0):/tmp/minicam-systemd/
	ssh $(PI0) "sudo cp /tmp/minicam-systemd/*.service $(SYSTEMD_DIR)/ && sudo systemctl daemon-reload"

bootstrap:
	rsync -av deploy/bootstrap-pi0.sh $(PI0):/tmp/
	ssh $(PI0) "bash /tmp/bootstrap-pi0.sh"

logs:
	ssh $(PI0) "journalctl -u minicam-api -f"

restart:
	ssh $(PI0) "sudo systemctl restart minicam-api"

status:
	ssh $(PI0) "sudo systemctl status minicam-api minicam-ui minicam-net-usb minicam-net-wifi --no-pager"
