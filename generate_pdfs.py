"""Generate Ark Financial 10DLC supporting documents."""
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.colors import HexColor
from reportlab.lib.units import inch
from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_JUSTIFY
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, HRFlowable, Table, TableStyle,
    Frame, PageTemplate, BaseDocTemplate
)
from reportlab.pdfgen import canvas
import os

OUTPUT_DIR = os.path.dirname(os.path.abspath(__file__))
NAVY = HexColor("#0D1B2A")
ACCENT = HexColor("#1B3A5C")
LIGHT_BG = HexColor("#F4F6F8")
BORDER = HexColor("#C8D0D8")

styles = getSampleStyleSheet()

# Custom styles
title_style = ParagraphStyle(
    'DocTitle', parent=styles['Title'],
    fontSize=22, leading=28, textColor=NAVY,
    spaceAfter=4, alignment=TA_CENTER, fontName='Helvetica-Bold'
)
subtitle_style = ParagraphStyle(
    'DocSubtitle', parent=styles['Normal'],
    fontSize=11, leading=14, textColor=HexColor("#555555"),
    spaceAfter=20, alignment=TA_CENTER, fontName='Helvetica'
)
heading_style = ParagraphStyle(
    'SectionHeading', parent=styles['Heading2'],
    fontSize=13, leading=18, textColor=ACCENT,
    spaceBefore=18, spaceAfter=8, fontName='Helvetica-Bold',
    borderPadding=(0, 0, 2, 0)
)
body_style = ParagraphStyle(
    'BodyText2', parent=styles['Normal'],
    fontSize=10.5, leading=15, textColor=HexColor("#333333"),
    spaceAfter=6, fontName='Helvetica', alignment=TA_JUSTIFY
)
bullet_style = ParagraphStyle(
    'BulletItem', parent=body_style,
    leftIndent=24, bulletIndent=12, spaceAfter=3,
    bulletFontName='Helvetica', bulletFontSize=10.5
)
footer_style = ParagraphStyle(
    'FooterStyle', parent=styles['Normal'],
    fontSize=8, textColor=HexColor("#999999"), alignment=TA_CENTER
)
contact_style = ParagraphStyle(
    'ContactStyle', parent=body_style,
    leftIndent=24, spaceAfter=3
)


def make_header_line():
    return HRFlowable(width="100%", thickness=2, color=NAVY, spaceAfter=16, spaceBefore=4)


def make_section_line():
    return HRFlowable(width="100%", thickness=0.5, color=BORDER, spaceAfter=8, spaceBefore=2)


# ─── PDF 1: Opt-In Documentation ───

class OptInDocTemplate(BaseDocTemplate):
    def __init__(self, filename, **kwargs):
        super().__init__(filename, **kwargs)
        frame = Frame(
            self.leftMargin, self.bottomMargin + 30,
            self.width, self.height - 30,
            id='normal'
        )
        template = PageTemplate(id='main', frames=frame, onPage=self._draw_footer)
        self.addPageTemplates([template])

    @staticmethod
    def _draw_footer(canvas_obj, doc):
        canvas_obj.saveState()
        canvas_obj.setFont('Helvetica', 8)
        canvas_obj.setFillColor(HexColor("#999999"))
        canvas_obj.drawCentredString(
            letter[0] / 2, 30,
            "This document is provided as supporting documentation for 10DLC campaign registration."
        )
        canvas_obj.restoreState()


def create_opt_in_pdf():
    filepath = os.path.join(OUTPUT_DIR, "ARK_Financial_SMS_Opt_In_Documentation.pdf")
    doc = OptInDocTemplate(
        filepath, pagesize=letter,
        rightMargin=60, leftMargin=60, topMargin=50, bottomMargin=50
    )

    story = []

    # Title block
    story.append(Paragraph("Ark Financial", title_style))
    story.append(Paragraph("SMS Opt-In Documentation", ParagraphStyle(
        'SubHead', parent=subtitle_style, fontSize=14, textColor=ACCENT,
        fontName='Helvetica-Bold', spaceAfter=6
    )))
    story.append(Paragraph("March 20, 2026", subtitle_style))
    story.append(make_header_line())

    # 1. Overview
    story.append(Paragraph("1. Overview", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "Ark Financial provides accounting, tax preparation, payroll, and bookkeeping services "
        "to individuals and businesses. As part of our client communications, Ark Financial sends "
        "SMS (text) messages for account-related notifications to keep clients informed about "
        "important updates regarding their services.",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 2. Opt-In Process
    story.append(Paragraph("2. Opt-In Process", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "Clients provide their phone number and written consent to receive SMS communications "
        "during the client onboarding process. Consent is collected via the client intake form "
        "signed at the beginning of the engagement. The intake form includes a clear disclosure "
        "that the client agrees to receive text messages from Ark Financial for account-related "
        "communications.",
        body_style
    ))
    story.append(Spacer(1, 4))
    story.append(Paragraph(
        "Consent is voluntary. Clients who do not wish to receive SMS messages may decline "
        "during onboarding or opt out at any time after enrollment.",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 3. Types of Messages Sent
    story.append(Paragraph("3. Types of Messages Sent", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "Ark Financial sends the following types of SMS messages to consenting clients:",
        body_style
    ))
    bullets = [
        "Account updates and reminders",
        "Payroll processing notifications",
        "Tax filing deadlines and status updates",
        "Appointment confirmations and reminders",
        "Billing and invoice notifications",
    ]
    for b in bullets:
        story.append(Paragraph(b, bullet_style, bulletText="\u2022"))
    story.append(Spacer(1, 6))

    # 4. Message Frequency
    story.append(Paragraph("4. Message Frequency", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "Message frequency varies depending on the client's active services and account activity. "
        "Typically, clients can expect to receive 1\u20135 messages per month. During peak periods "
        "(such as tax season), message frequency may temporarily increase.",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 5. Opt-Out Process
    story.append(Paragraph("5. Opt-Out Process", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "Clients may opt out of SMS communications at any time by replying <b>STOP</b> to any "
        "message received from Ark Financial. Upon receiving a STOP request, the client's phone "
        "number is immediately removed from all SMS communications.",
        body_style
    ))
    story.append(Spacer(1, 4))
    story.append(Paragraph(
        "Clients may also contact Ark Financial directly to opt out:",
        body_style
    ))
    story.append(Paragraph("<b>Phone:</b> (402) 287-7085", contact_style))
    story.append(Paragraph("<b>Email:</b> ark.devgen@gmail.com", contact_style))
    story.append(Spacer(1, 6))

    # 6. Cost Disclaimer
    story.append(Paragraph("6. Cost Disclaimer", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "Message and data rates may apply based on the client's mobile carrier plan. "
        "Ark Financial does not charge any fees for sending or receiving SMS messages.",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 7. Contact Information
    story.append(Paragraph("7. Contact Information", heading_style))
    story.append(make_section_line())
    story.append(Paragraph("<b>Ark Financial</b>", body_style))
    story.append(Paragraph("<b>Phone:</b> (402) 287-7085", contact_style))
    story.append(Paragraph("<b>Email:</b> ark.devgen@gmail.com", contact_style))

    doc.build(story)
    print(f"Created: {filepath}")


# ─── PDF 2: Privacy Policy ───

class PrivacyDocTemplate(BaseDocTemplate):
    def __init__(self, filename, **kwargs):
        super().__init__(filename, **kwargs)
        frame = Frame(
            self.leftMargin, self.bottomMargin + 30,
            self.width, self.height - 30,
            id='normal'
        )
        template = PageTemplate(id='main', frames=frame, onPage=self._draw_footer)
        self.addPageTemplates([template])

    @staticmethod
    def _draw_footer(canvas_obj, doc):
        canvas_obj.saveState()
        canvas_obj.setFont('Helvetica', 8)
        canvas_obj.setFillColor(HexColor("#999999"))
        canvas_obj.drawCentredString(
            letter[0] / 2, 30,
            "Ark Financial \u2014 Privacy Policy \u2014 Effective March 20, 2026"
        )
        page_num = canvas_obj.getPageNumber()
        canvas_obj.drawRightString(letter[0] - 60, 30, f"Page {page_num}")
        canvas_obj.restoreState()


def create_privacy_policy_pdf():
    filepath = os.path.join(OUTPUT_DIR, "ARK_Financial_Privacy_Policy.pdf")
    doc = PrivacyDocTemplate(
        filepath, pagesize=letter,
        rightMargin=60, leftMargin=60, topMargin=50, bottomMargin=50
    )

    story = []

    # Title block
    story.append(Paragraph("Ark Financial", title_style))
    story.append(Paragraph("Privacy Policy", ParagraphStyle(
        'SubHead2', parent=subtitle_style, fontSize=14, textColor=ACCENT,
        fontName='Helvetica-Bold', spaceAfter=6
    )))
    story.append(Paragraph("Effective Date: March 20, 2026", subtitle_style))
    story.append(make_header_line())

    # 1. Introduction
    story.append(Paragraph("1. Introduction", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        'Ark Financial ("we," "us," "our") is committed to protecting the privacy of our clients. '
        "This Privacy Policy explains how we collect, use, store, and safeguard personal information "
        "in connection with the accounting, tax preparation, payroll, and bookkeeping services we provide.",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 2. Information We Collect
    story.append(Paragraph("2. Information We Collect", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "In the course of providing our services, we may collect the following types of personal information:",
        body_style
    ))
    info_items = [
        "Name, address, phone number, and email address",
        "Social Security numbers and tax identification numbers (for tax preparation services)",
        "Financial records, bank statements, and payroll data",
        "Business information for bookkeeping and accounting clients",
        "Employment and wage information for payroll processing",
    ]
    for item in info_items:
        story.append(Paragraph(item, bullet_style, bulletText="\u2022"))
    story.append(Spacer(1, 6))

    # 3. How We Use Your Information
    story.append(Paragraph("3. How We Use Your Information", heading_style))
    story.append(make_section_line())
    story.append(Paragraph("We use the information we collect for the following purposes:", body_style))
    use_items = [
        "To provide accounting, tax preparation, payroll, and bookkeeping services",
        "To communicate with you about your account via phone, email, and SMS",
        "To send appointment reminders, filing deadlines, and account notifications",
        "To process payroll and generate required tax documents",
        "To comply with legal and regulatory requirements",
    ]
    for item in use_items:
        story.append(Paragraph(item, bullet_style, bulletText="\u2022"))
    story.append(Spacer(1, 6))

    # 4. SMS Communications
    story.append(Paragraph("4. SMS Communications", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "We may send SMS (text) messages to the phone number you provide for account-related "
        "communications. By providing your phone number and signing our client intake form, you "
        "consent to receive these messages.",
        body_style
    ))
    story.append(Spacer(1, 4))
    sms_items = [
        "You may opt out at any time by replying <b>STOP</b> to any message",
        "Message frequency varies (typically 1\u20135 messages per month)",
        "Message and data rates may apply based on your mobile carrier plan",
        "Ark Financial does not charge any fees for SMS messages",
    ]
    for item in sms_items:
        story.append(Paragraph(item, bullet_style, bulletText="\u2022"))
    story.append(Spacer(1, 6))

    # 5. Information Sharing
    story.append(Paragraph("5. Information Sharing and Disclosure", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "We do not sell, trade, or rent your personal information to third parties. "
        "We may share information only in the following limited circumstances:",
        body_style
    ))
    share_items = [
        "<b>Service Providers:</b> Third-party providers who assist in delivering our services "
        "(e.g., payroll processors, tax filing systems, secure document storage)",
        "<b>Legal Requirements:</b> Government agencies as required by law, regulation, or legal process",
        "<b>Professional Advisors:</b> As necessary to provide our professional services to you",
    ]
    for item in share_items:
        story.append(Paragraph(item, bullet_style, bulletText="\u2022"))
    story.append(Spacer(1, 4))
    story.append(Paragraph(
        "All third-party service providers are bound by confidentiality agreements and are "
        "prohibited from using your information for any purpose other than providing the "
        "contracted services.",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 6. Data Security
    story.append(Paragraph("6. Data Security", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "We implement appropriate technical and organizational measures to protect your personal "
        "information against unauthorized access, alteration, disclosure, or destruction. "
        "These measures include:",
        body_style
    ))
    sec_items = [
        "Encrypted storage systems for sensitive financial and personal data",
        "Secure client portals for document exchange",
        "Restricted access controls limiting data access to authorized personnel only",
        "Regular security reviews and updates to our systems",
    ]
    for item in sec_items:
        story.append(Paragraph(item, bullet_style, bulletText="\u2022"))
    story.append(Spacer(1, 6))

    # 7. Data Retention
    story.append(Paragraph("7. Data Retention", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "We retain client records for a minimum of seven (7) years in accordance with IRS "
        "requirements and professional accounting standards. After the applicable retention "
        "period, records are securely destroyed using industry-standard methods.",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 8. Your Rights
    story.append(Paragraph("8. Your Rights", heading_style))
    story.append(make_section_line())
    story.append(Paragraph("As a client, you have the right to:", body_style))
    rights_items = [
        "Access your personal information held by Ark Financial",
        "Request corrections to inaccurate or incomplete data",
        "Request deletion of your data (subject to legal retention requirements)",
        "Opt out of SMS communications at any time by replying STOP or contacting us directly",
        "Receive a copy of your personal data in a commonly used format",
    ]
    for item in rights_items:
        story.append(Paragraph(item, bullet_style, bulletText="\u2022"))
    story.append(Spacer(1, 4))
    story.append(Paragraph(
        "To exercise any of these rights, please contact us using the information provided below.",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 9. Changes to This Policy
    story.append(Paragraph("9. Changes to This Policy", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "We may update this Privacy Policy from time to time to reflect changes in our practices "
        "or applicable regulations. Any material changes will be communicated to clients directly "
        "via email or SMS notification. The effective date at the top of this document indicates "
        "when the policy was last updated.",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 10. Contact Us
    story.append(Paragraph("10. Contact Us", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "If you have any questions or concerns about this Privacy Policy or our data practices, "
        "please contact us:",
        body_style
    ))
    story.append(Spacer(1, 4))
    story.append(Paragraph("<b>Ark Financial</b>", body_style))
    story.append(Paragraph("<b>Phone:</b> (402) 287-7085", contact_style))
    story.append(Paragraph("<b>Email:</b> ark.devgen@gmail.com", contact_style))

    doc.build(story)
    print(f"Created: {filepath}")


# ─── PDF 3: SMS Terms & Conditions ───

class TermsDocTemplate(BaseDocTemplate):
    def __init__(self, filename, **kwargs):
        super().__init__(filename, **kwargs)
        frame = Frame(
            self.leftMargin, self.bottomMargin + 30,
            self.width, self.height - 30,
            id='normal'
        )
        template = PageTemplate(id='main', frames=frame, onPage=self._draw_footer)
        self.addPageTemplates([template])

    @staticmethod
    def _draw_footer(canvas_obj, doc):
        canvas_obj.saveState()
        canvas_obj.setFont('Helvetica', 8)
        canvas_obj.setFillColor(HexColor("#999999"))
        canvas_obj.drawCentredString(
            letter[0] / 2, 30,
            "Ark Financial \u2014 SMS Terms & Conditions \u2014 Effective March 20, 2026"
        )
        page_num = canvas_obj.getPageNumber()
        canvas_obj.drawRightString(letter[0] - 60, 30, f"Page {page_num}")
        canvas_obj.restoreState()


def create_terms_pdf():
    filepath = os.path.join(OUTPUT_DIR, "Ark_Financial_SMS_Terms_and_Conditions.pdf")
    doc = TermsDocTemplate(
        filepath, pagesize=letter,
        rightMargin=60, leftMargin=60, topMargin=50, bottomMargin=50
    )

    story = []

    # Title block
    story.append(Paragraph("Ark Financial", title_style))
    story.append(Paragraph("SMS Terms &amp; Conditions", ParagraphStyle(
        'SubHead3', parent=subtitle_style, fontSize=14, textColor=ACCENT,
        fontName='Helvetica-Bold', spaceAfter=6
    )))
    story.append(Paragraph("Effective Date: March 20, 2026", subtitle_style))
    story.append(make_header_line())

    # 1. Program Description
    story.append(Paragraph("1. Program Description", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "Ark Financial provides an SMS messaging program to communicate account-related information "
        "to our clients. By opting in, you agree to receive text messages from Ark Financial regarding "
        "your account, including but not limited to:",
        body_style
    ))
    prog_items = [
        "Payroll processing notifications",
        "Tax filing deadline reminders and status updates",
        "Appointment confirmations and reminders",
        "Billing and invoice notifications",
        "General account updates and communications",
    ]
    for item in prog_items:
        story.append(Paragraph(item, bullet_style, bulletText="\u2022"))
    story.append(Spacer(1, 6))

    # 2. Opt-In and Consent
    story.append(Paragraph("2. Opt-In and Consent", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "By providing your phone number to Ark Financial and signing our client intake form, you "
        "expressly consent to receive account-related SMS messages from Ark Financial at the phone "
        "number provided. Consent is not a condition of purchasing any goods or services. You may "
        "opt in during client onboarding or by contacting our office directly.",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 3. Message Frequency
    story.append(Paragraph("3. Message Frequency", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "Message frequency varies depending on your active services and account activity. Typically, "
        "you can expect to receive 1\u20135 messages per month. During peak periods (such as tax season), "
        "message frequency may temporarily increase.",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 4. Message and Data Rates
    story.append(Paragraph("4. Message and Data Rates", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "Message and data rates may apply depending on your mobile carrier plan. Ark Financial does "
        "not charge any fees for sending or receiving SMS messages. Please contact your mobile carrier "
        "for details about your messaging plan.",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 5. Opt-Out Instructions
    story.append(Paragraph("5. Opt-Out Instructions", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "You may opt out of receiving SMS messages at any time by replying <b>STOP</b> to any "
        "message received from Ark Financial. Upon receiving your STOP request, we will confirm your "
        "unsubscription and you will no longer receive SMS messages from us.",
        body_style
    ))
    story.append(Spacer(1, 4))
    story.append(Paragraph("You may also opt out by contacting us directly:", body_style))
    story.append(Paragraph("<b>Phone:</b> (402) 287-7085", contact_style))
    story.append(Paragraph("<b>Email:</b> ark.devgen@gmail.com", contact_style))
    story.append(Spacer(1, 6))

    # 6. Help and Support
    story.append(Paragraph("6. Help and Support", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "For help or more information about our SMS program, reply <b>HELP</b> to any message "
        "or contact us at:",
        body_style
    ))
    story.append(Paragraph("<b>Phone:</b> (402) 287-7085", contact_style))
    story.append(Paragraph("<b>Email:</b> ark.devgen@gmail.com", contact_style))
    story.append(Spacer(1, 6))

    # 7. Privacy
    story.append(Paragraph("7. Privacy", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "We respect your privacy. Your phone number and personal information will not be sold, rented, "
        "or shared with third parties for marketing purposes. For complete details on how we handle your "
        "data, please review our Privacy Policy at "
        "<a href='https://ark-qbo-server.onrender.com/privacy-policy' color='#1B3A5C'>"
        "https://ark-qbo-server.onrender.com/privacy-policy</a>.",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 8. Supported Carriers
    story.append(Paragraph("8. Supported Carriers", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "Our SMS program is supported by all major U.S. mobile carriers. Carriers are not liable for "
        "delayed or undelivered messages.",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 9. Changes to Terms
    story.append(Paragraph("9. Changes to Terms", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "We may update these Terms & Conditions from time to time. Any material changes will be "
        "communicated to subscribers via SMS or email. Continued participation in the SMS program "
        "after changes are communicated constitutes acceptance of the updated terms.",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 10. Contact Us
    story.append(Paragraph("10. Contact Us", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "If you have any questions about these terms, please contact us:",
        body_style
    ))
    story.append(Spacer(1, 4))
    story.append(Paragraph("<b>Ark Financial</b>", body_style))
    story.append(Paragraph("<b>Phone:</b> (402) 287-7085", contact_style))
    story.append(Paragraph("<b>Email:</b> ark.devgen@gmail.com", contact_style))

    doc.build(story)
    print(f"Created: {filepath}")


# ─── PDF 4: Call to Action ───

class CTADocTemplate(BaseDocTemplate):
    def __init__(self, filename, **kwargs):
        super().__init__(filename, **kwargs)
        frame = Frame(
            self.leftMargin, self.bottomMargin + 30,
            self.width, self.height - 30,
            id='normal'
        )
        template = PageTemplate(id='main', frames=frame, onPage=self._draw_footer)
        self.addPageTemplates([template])

    @staticmethod
    def _draw_footer(canvas_obj, doc):
        canvas_obj.saveState()
        canvas_obj.setFont('Helvetica', 8)
        canvas_obj.setFillColor(HexColor("#999999"))
        canvas_obj.drawCentredString(
            letter[0] / 2, 30,
            "Ark Financial \u2014 SMS Call to Action \u2014 Effective March 20, 2026"
        )
        page_num = canvas_obj.getPageNumber()
        canvas_obj.drawRightString(letter[0] - 60, 30, f"Page {page_num}")
        canvas_obj.restoreState()


def create_cta_pdf():
    filepath = os.path.join(OUTPUT_DIR, "Ark_Financial_SMS_Call_to_Action.pdf")
    doc = CTADocTemplate(
        filepath, pagesize=letter,
        rightMargin=60, leftMargin=60, topMargin=50, bottomMargin=50
    )

    story = []

    # Title block
    story.append(Paragraph("Ark Financial", title_style))
    story.append(Paragraph("SMS Call to Action", ParagraphStyle(
        'SubHead4', parent=subtitle_style, fontSize=14, textColor=ACCENT,
        fontName='Helvetica-Bold', spaceAfter=6
    )))
    story.append(Paragraph("Effective Date: March 20, 2026", subtitle_style))
    story.append(make_header_line())

    # 1. Program Overview
    story.append(Paragraph("1. Program Overview", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "Ark Financial is a professional accounting firm that sends SMS (text) messages to clients "
        "for account-related communications. Messages include payroll processing notifications, tax "
        "filing deadline reminders, appointment confirmations, billing updates, and general account "
        "status notifications.",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 2. How Clients Opt In
    story.append(Paragraph("2. How Clients Opt In", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "Clients of Ark Financial provide their phone number and sign a client intake form during "
        "the onboarding process. The intake form includes a dedicated SMS consent section with the "
        "following disclosure:",
        body_style
    ))
    story.append(Spacer(1, 8))

    # Consent box
    consent_text = (
        '<i>"I agree to receive account-related text messages from Ark Financial, including '
        "appointment reminders, payroll notifications, tax filing updates, and billing notices. "
        "Message frequency varies (typically 1\u20135 msgs/mo). Msg &amp; data rates may apply. "
        'Reply STOP to stop. Reply HELP for help."</i>'
    )
    consent_style = ParagraphStyle(
        'ConsentBox', parent=body_style,
        leftIndent=20, rightIndent=20, spaceBefore=8, spaceAfter=8,
        borderPadding=12, backColor=LIGHT_BG,
        fontSize=11, leading=16,
    )
    story.append(Paragraph(consent_text, consent_style))
    story.append(Spacer(1, 8))

    story.append(Paragraph(
        "Consent is collected in person during the client onboarding meeting or via signed engagement "
        "letter before any messages are sent. Consent is voluntary and is not a condition of service.",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 3. Message Details
    story.append(Paragraph("3. Message Details", heading_style))
    story.append(make_section_line())
    msg_items = [
        "<b>Brand Name:</b> Ark Financial",
        "<b>Message Frequency:</b> Varies, typically 1\u20135 messages per month",
        "<b>Message &amp; Data Rates:</b> May apply based on carrier plan",
        "<b>Ark Financial does not charge</b> any fees for SMS messages",
    ]
    for item in msg_items:
        story.append(Paragraph(item, bullet_style, bulletText="\u2022"))
    story.append(Spacer(1, 6))

    # 4. Opt-Out Instructions
    story.append(Paragraph("4. Opt-Out Instructions", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "Clients may opt out of SMS communications at any time by replying <b>STOP</b> to any "
        "message received from Ark Financial. Upon receiving a STOP request, the client is "
        "immediately unsubscribed and will receive a confirmation message.",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 5. Help Instructions
    story.append(Paragraph("5. Help Instructions", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "Clients may reply <b>HELP</b> to any message for assistance. They may also contact "
        "Ark Financial directly for support:",
        body_style
    ))
    story.append(Paragraph("<b>Phone:</b> (402) 287-7085", contact_style))
    story.append(Paragraph("<b>Email:</b> ark.devgen@gmail.com", contact_style))
    story.append(Spacer(1, 6))

    # 6. Terms & Privacy
    story.append(Paragraph("6. Terms &amp; Privacy Links", heading_style))
    story.append(make_section_line())
    story.append(Paragraph(
        "Full SMS Terms &amp; Conditions are available at:<br/>"
        "<a href='https://ark-qbo-server.onrender.com/terms' color='#1B3A5C'>"
        "https://ark-qbo-server.onrender.com/terms</a>",
        body_style
    ))
    story.append(Spacer(1, 4))
    story.append(Paragraph(
        "Full Privacy Policy is available at:<br/>"
        "<a href='https://ark-qbo-server.onrender.com/privacy-policy' color='#1B3A5C'>"
        "https://ark-qbo-server.onrender.com/privacy-policy</a>",
        body_style
    ))
    story.append(Spacer(1, 6))

    # 7. Sample Messages
    story.append(Paragraph("7. Sample Messages", heading_style))
    story.append(make_section_line())
    samples = [
        "Ark Financial: Your payroll for the period ending 03/15 has been processed successfully. "
        "Please review your pay stubs at your earliest convenience. Reply STOP to opt out.",
        "Ark Financial: Reminder \u2014 your quarterly estimated tax payment (Q1 2026) is due on "
        "April 15th. Please contact us if you have any questions. Reply STOP to opt out.",
        "Ark Financial: Your appointment with our team is confirmed for Thursday at 2:00 PM. "
        "Please let us know if you need to reschedule. Reply STOP to opt out.",
        "Ark Financial: Your March invoice is ready. Amount due: $250.00. Please reach out if "
        "you have any questions about your billing. Reply STOP to opt out.",
    ]
    for i, s in enumerate(samples, 1):
        story.append(Paragraph(f"<b>Sample {i}:</b> {s}", bullet_style, bulletText="\u2022"))
    story.append(Spacer(1, 6))

    # 8. Contact Information
    story.append(Paragraph("8. Contact Information", heading_style))
    story.append(make_section_line())
    story.append(Paragraph("<b>Ark Financial</b>", body_style))
    story.append(Paragraph("<b>Phone:</b> (402) 287-7085", contact_style))
    story.append(Paragraph("<b>Email:</b> ark.devgen@gmail.com", contact_style))
    story.append(Paragraph(
        "<b>Website:</b> <a href='https://ark-qbo-server.onrender.com/about' color='#1B3A5C'>"
        "https://ark-qbo-server.onrender.com/about</a>",
        contact_style
    ))

    doc.build(story)
    print(f"Created: {filepath}")


if __name__ == "__main__":
    create_opt_in_pdf()
    create_privacy_policy_pdf()
    create_terms_pdf()
    create_cta_pdf()
    print("\nAll 4 PDFs generated successfully!")
