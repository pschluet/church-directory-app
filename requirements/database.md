# AWS RDS PostgreSQL Cheapest Configuration Blueprint

This configuration provides the lowest possible ongoing cost for a small, relational workload (such as a church directory) while ensuring fully managed backups and updates.

## 1. Engine & Availability
* **Database Engine:** PostgreSQL (Choose latest major version supported)
* **Template:** Dev/Test
* **Deployment Option:** Single DB Instance
  * *Note: Do NOT choose Multi-AZ. Multi-AZ doubles the baseline instance cost.*

## 2. Instance Specifications
* **Instance Class:** Burstable classes (includes t classes)
* **Instance Size:** `db.t4g.micro`
  * *Processor Architecture:* AWS Graviton (ARM64)
  * *Specs:* 2 vCPUs, 1 GiB RAM
  * *Why:* Faster and ~10% cheaper than equivalent Intel (`db.t3.micro`) instances.

## 3. Storage
* **Storage Type:** General Purpose SSD (gp3)
* **Allocated Storage:** 20 GiB (The minimum allowable baseline)
* **IOPS & Throughput:** Leave at baseline defaults (3000 IOPS / 125 MB/s)
* **Storage Autoscaling:** DISABLED (Uncheck "Enable storage autoscaling")
  * *Why:* Prevents automatic, permanent storage tier upgrades from temporary logs/migrations.

## 4. Maintenance & Monitoring (Cost Optimizations)
* **Performance Insights:** DISABLED (Uncheck "Enable Performance Insights")
* **Enhanced Monitoring:** DISABLED (Uncheck "Enable Enhanced Monitoring")
* **Backup Retention Period:** 7 Days (Provides a rolling week of automated backups without bloating backup storage costs)

## 💰 Estimated Cost Breakdown
* **Free Tier Eligibility:** $0.00 / month (For the first 12 months on a new AWS account; covers 750 hours/month of micro usage).
* **Standard Paid Cost:** ~$12.00 to $14.00 / month (Varies slightly by AWS region; storage and compute combined).
