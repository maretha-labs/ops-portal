# ops-portal — build & deploy helpers.
# Prereqs: terraform, aws cli, node/npm, and CLOUDFLARE_API_TOKEN exported.
# infra/terraform.tfvars filled (see SETUP.md).

INFRA := infra
WEB   := web

.PHONY: build deps apply plan web config invalidate deploy outputs

deps:                       ## vendor Lambda dependencies (needed before apply)
	cd lambda/api && npm install --omit=dev --no-audit --no-fund

plan: deps
	cd $(INFRA) && terraform init -input=false && terraform plan

apply: deps
	cd $(INFRA) && terraform init -input=false && terraform apply

outputs:
	cd $(INFRA) && terraform output

config:                     ## render web/config.js from terraform outputs
	cd $(INFRA) && \
	API=$$(terraform output -raw api_base_url) ; \
	DOMAIN=$$(terraform output -raw cognito_hosted_ui_domain) ; \
	CID=$$(terraform output -raw cognito_client_id) ; \
	URL=$$(terraform output -raw portal_url) ; \
	sed -e "s#__API_BASE__#$$API#" -e "s#__COGNITO_DOMAIN__#$$DOMAIN#" \
	    -e "s#__CLIENT_ID__#$$CID#" -e "s#__REDIRECT_URI__#$$URL/#" \
	    ../$(WEB)/config.js > ../$(WEB)/config.local.js
	@echo "wrote $(WEB)/config.local.js"

web: config                 ## sync the SPA to S3 + invalidate CloudFront
	cd $(INFRA) && \
	BUCKET=$$(terraform output -raw spa_bucket) ; \
	DIST=$$(terraform output -raw cloudfront_distribution_id) ; \
	aws s3 sync ../$(WEB)/ s3://$$BUCKET/ --exclude config.js --exclude "*.local.js" ; \
	aws s3 cp ../$(WEB)/config.local.js s3://$$BUCKET/config.js --content-type application/javascript ; \
	aws cloudfront create-invalidation --distribution-id $$DIST --paths "/*"

deploy: apply web           ## full deploy: infra + frontend
	@echo "Done. Portal: $$(cd $(INFRA) && terraform output -raw portal_url)"
