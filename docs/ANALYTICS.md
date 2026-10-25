# 🌐 Bihar Citizen Echo - Geo-Analytics & Civic Severity Engine

## Mathematical Formulation

The Civic Severity Scorer computes a deterministic Hazard Risk Index ($R$) scaled from 10 to 99:

$$R = \text{clamp}\Big(12, 99, \big(B \times D\big) + \beta_{\text{urgency}}\Big)$$

Where:
- **$B$ (Base Hazard Score)**:
  - Infrastructure Failure / Structural Collapse / Casualty: $+50$
  - Hospital / Healthcare Failure / Epidemic Outbreak: $+35$
  - Waterlogging / Drainage / Sewer Sump Overflow: $+30$
  - High-Voltage Electrical Grid / Transformer Blasts: $+25$
  - Road Cave-in / Severe Potholes / Highway Gridlock: $+20$
  - Baseline Routine Civic Issue: $+20$
- **$D$ (District Population Density Multiplier)**:
  - **Tier 1 (Metro Capital Zone)**: Patna $\rightarrow 1.30\times$
  - **Tier 2 (Major Municipal Corporations)**: Muzaffarpur, Gaya, Bhagalpur $\rightarrow 1.18\times$
  - **Tier 3 (Regional Nodal Hubs)**: Darbhanga, Purnia, Begusarai $\rightarrow 1.12\times$
  - **Tier 4 (Rural / Semi-Urban Sectors)**: Standard $\rightarrow 1.00\times$
- **$\beta_{\text{urgency}}$ (DeepSeek AI Bias Modifier)**:
  $$\beta_{\text{urgency}} = (U - 3) \times 6$$
  where $U \in [1, 5]$ is the urgency score extracted by DeepSeek.

## Response Priority Classification
| Hazard Score Range | Classification | Routing Action |
|:---|:---|:---|
| **80 – 99** | `CRITICAL_DISASTER` | Immediate DM & SDRF alert dispatch |
| **60 – 79** | `HIGH_ALERT` | Priority department response (PMC, BSPHCL, RCD) |
| **35 – 59** | `STANDARD_RESPONSE` | Routine municipal queue assignment |
| **12 – 34** | `LOW_ROUTINE` | Standard portal ticket logging |

## District Magistrate Intelligence Brief
The platform provides a one-click administrative executive brief compiled directly from radar coordinates:
- Aggregates real-time grievance density per district
- Breaks down critical hazards versus routine issues
- Identifies actionable administrative remedies mapped to responsible municipal bodies
- Generates print-ready executive summaries for administrative reviews
